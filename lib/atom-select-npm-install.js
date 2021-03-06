'use babel';

import { CompositeDisposable } from 'atom';
import findDeps from 'atom-selected-requires';
import pkgConf from 'pkg-conf';
import path from 'path';
import relative from 'relative-require-regex';
import resolve from 'resolve';
import $ from 'jquery';
import execa from 'execa';
import { MessagePanelView, PlainMessageView } from 'atom-message-panel';
import split from 'split';
import Combine from 'combine-stream';
import ansiHTML from 'ansi-to-html';
import pkgDir from 'pkg-dir';
import which from 'which';
import isModuleInstalled from './is-module-installed';
import uniqArray from './unique-string-array';
import configSchema from './config-schema';

const convert = new ansiHTML({
	newline: false,
	escapeXML: false,
	stream: true
});
const ansiToHtml = content => convert.toHtml( content );

const pos = {
	top: 0,
	left: 0,
};
const TYPE_DEPENDENCIES = 1;
const TYPE_DEV_DEPENDENCIES = 2;

export default {
	subscriptions: null,
	panel: null,
	cp: null,
	root: null,
	config: configSchema,

	install( root, deps, type ) {
		if( !root ) {
			atom.notifications.addError('project root not found', {});
			return;
		}

		// yarn npm or cnpm
		const installCommand = atom.config.get( 'atom-select-npm-install.installCommand' );
		const commandFindPath = process.env.Path + ':/usr/bin/node:/usr/local/bin';

		let commandName;
		if ( process.platform === 'win32' ) {
			commandName = `${ installCommand }.cmd`;
		} else {
			commandName = installCommand;
		}

		which( commandName, {
			path: commandFindPath
		}, ( err, npm ) => {
			if( err ) {
				console.log( 'err', err );
				return err;
			}

			const commandMaps = {
				yarn: 'add',
				npm: 'install',
				cnpm: 'install',
			};
			const args = [ commandMaps[ installCommand ], ...deps ];

			if ( installCommand === 'yarn' ) {
				if ( type === TYPE_DEV_DEPENDENCIES ) {
					args.push( '--dev' );
				}
			} else {
				if ( type === TYPE_DEV_DEPENDENCIES ) {
					args.push( '-D' );
				} else {
					args.push( '-S' );
				}
				args.push( '-d' );
			}

			if ( this.panel ) {
				this.panel.close();
			}
			const panel = new MessagePanelView( { autoScroll: true } );
			panel.setTitle( `${ installCommand } ${ args.join( ' ' ) }` );
			panel.clear();
			panel.attach();

			if( this.cp ) {
				this.cp.kill();
				this.cp = null;
			}

			const cp = execa( npm, args, { cwd: root } );
			const output = new Combine( [ cp.stdout, cp.stderr ] );
			output.pipe( split() ).on( 'data', line => {
				line = ansiToHtml( line ).replace( / /g, function( match, offset, total ) {
					if( /^ *$/.test( total.slice( 0, offset ) ) ) {
						return '&nbsp;';
					} else {
						return ' ';
					}
				} );
				panel.add( new PlainMessageView( {
					message: line,
					raw: true
				} ) );
				panel.updateScroll();
			} );

			cp.on( 'close', code => {
				console.log('child process exited with code ' + code);
				if( code === 0 ) {
					panel.toggle();
				}
			} );

			this.cp = cp;
			this.panel = panel;
		} );
	},

	activate( state ) {
		let deps = [];
		let $tooltip;

		this.subscriptions = new CompositeDisposable();

		this.subscriptions.add( atom.workspace.onDidStopChangingActivePaneItem( () => {
			if ( typeof $tooltip !== 'undefined' ) {
				$tooltip.remove();
			}
		} ) );

		this.subscriptions.add( atom.workspace.observeTextEditors( editor => {
			// only support those file extensions
			if( !/\.(js|jsx|es6|tag|vue)$/.test( editor.getPath() ) ) {
				return;
			}

			const editorElement = atom.views.getView( editor );
			const $editorElement = $( editorElement );
			const $editorScrollElement = $( editorElement ).find( '.scroll-view' );

			$editorElement.off( 'mousemove' ).on( 'mousemove', e => {
				const offset = $editorElement.offset();
				pos.top = e.pageY;
				pos.left = e.pageX;
			} );

			$editorElement.off( 'mouseup' ).on( 'mouseup', e => {
				if ( typeof $tooltip !== 'undefined' ) {
					$tooltip.remove();
				}

				if ( deps.length > 0 ) {
					deps = uniqArray( deps );
					$tooltip = $( `
						<div class="tooltip fade bottom in atom-select-npm-install" role="tooltip" style="display: block;">
							<div class="tooltip-arrow" style="left: 50%;"></div>
							<div class="tooltip-inner">
								<div class="J_deps">
									${deps.map(dep => {
										return `
											<div class="tag">
												<div class="checkbox">
													<label for="atom-select-npm-install:${dep}">
														<input id="atom-select-npm-install:${dep}" data-value="${dep}" type="checkbox" checked="checked">
														<div class="setting-title">${dep}</div>
													</label>
												</div>
											</div>
										`;
									}).join('')}
								</div>
								<div class="sep"></div>
								<div class="checkbox">
									<label for="atom-select-npm-install:devDependencies">
										<input class="J_installAsDevDependencies" id="atom-select-npm-install:devDependencies" type="checkbox">
										<div class="setting-title">Install as devDependencies</div>
									</label>
								</div>
								<button class="J_install">install</button>
							</div>
						</div>
					` ).css( {
						top: pos.top + 1,
						left: pos.left + 1,
						transform: 'translateX(-50%)',
						'-webkit-transform': 'translateX(-50%)',
					} ).find( '.J_install' ).on( 'click', () => {
						// filter selected deps
						const $checkboxes = $tooltip.find( '.J_deps input[type="checkbox"]:checked' );
						const checkedDeps = $checkboxes.map(( i, c ) => {
							return c.getAttribute( 'data-value' );
						});

						// dep type
						let type = TYPE_DEPENDENCIES;
						const installAsDevDependencies = $tooltip.find( '.J_installAsDevDependencies' )[0].checked;
						if( installAsDevDependencies ) {
							type = TYPE_DEV_DEPENDENCIES;
						}

						this.install( this.root, checkedDeps, type );
						deps = [];
						$tooltip.remove();
					} ).end();
					$( 'body' ).append( $tooltip );
				}
			} );

			this.subscriptions.add( editor.onDidChangeSelectionRange( e => {
				const bufferRange = e.newBufferRange;
				const cursor = e.selection.cursor;

				deps = [];

				if ( bufferRange.isEmpty() ) {
					return;
				}

				const content = editor.getTextInBufferRange( bufferRange );
				if (
					!content.includes( 'require' ) &&
					!content.includes( 'import' )
				) {
					return;
				}

				try {
					deps = findDeps( editor );
				} catch( e ) {
					atom.notifications.addError( `failed to resolve dependencies`, {} );
					return;
				}
				deps = deps
					.filter( name => !relative().test( name ) )
					.filter( name => !resolve.isCore( name ) )
					.map( dir => dir.split( '/' )[ 0 ] )

				this.root = pkgDir.sync( editor.getPath() );

				// 过滤已安装的模块，对npm3不适用，暂时注释
				// if( this.root ) {
				// 	deps = deps.filter(name => !isModuleInstalled( name, this.root ));
				// }
			} ) );
		} ) );
	},

	deactivate() {
		this.subscriptions.dispose();
	},

	serialize() {
		return {};
	},
};
