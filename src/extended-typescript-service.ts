import { walkMostAST } from 'javascript-typescript-langserver/lib/ast'
import { LanguageClient } from 'javascript-typescript-langserver/lib/lang-handler'
import {InitializeParams, SymbolDescriptor} from 'javascript-typescript-langserver/lib/request-type'
import {
    definitionInfoToSymbolDescriptor,
    locationUri,
    navigationTreeIsSymbol,
    navigationTreeToSymbolInformation,
    stringtoSymbolKind,
    walkNavigationTree,
} from 'javascript-typescript-langserver/lib/symbols'
import { TypeScriptService, TypeScriptServiceOptions } from 'javascript-typescript-langserver/lib/typescript-service'
import { normalizeUri, observableFromIterable, path2uri, uri2path } from 'javascript-typescript-langserver/lib/util'

import { Operation } from 'fast-json-patch'
import { Span } from 'opentracing'
import { Observable } from 'rxjs'
import * as ts from 'typescript'
import { Location, MarkupKind, SymbolInformation } from 'vscode-languageserver'

import { DetailSymbolInformation, Full, FullParams, Reference, ReferenceCategory } from './lsp-extend'
import {DependencyManager} from "./dependency-manager";

import * as rxjs from 'rxjs'

export class ExtendedTypescriptService extends TypeScriptService {
    private dependencyManager: DependencyManager | null; // TODO should we assign null

    private subscriptions = new rxjs.Subscription()

    constructor(protected client: LanguageClient, protected options: TypeScriptServiceOptions = {}) {
        super(client, options)
    }

    initialize(params: InitializeParams, span?: Span) {
        // TODO what about the promise here?
        // TODO run dependencyManager
        return super.initialize(params).finally(() => {
            // Must run after super.initialize
            this.dependencyManager = new DependencyManager(this.projectManager, this.packageManager, this.inMemoryFileSystem);

            // Similar to promise then
            this.subscriptions.add(
                Observable.defer(() => {
                    if (this.dependencyManager) {
                        this.fileSystem.getWorkspaceFiles().forEach(f => {
                            if (f.endsWith("package.json")) { // this ensure the file is updated to package manager
                                this.fileSystem.getTextDocumentContent(f).forEach(c => {
                                    console.log(this.packageManager.packageJsonUris()); // just test code
                                })
                            }
                        })

                        // fileContentPair.forEach(p => {
                        //     this.inMemoryFileSystem.add(p[0], p(1))
                        // })

                        return this.dependencyManager.installDependency()
                    } else {
                        this.logger.error("dependencyManager null")
                        // TODO is this the right way?
                        return Promise.resolve();
                    }
                }).subscribe(undefined, e => {
                        this.logger.info('xxx', e);
                    }
                )
            )
        })
    }

    shutdown(params?: {}, span?: Span) {
        this.subscriptions.unsubscribe();

        // TODO shutdown depenency manager
        if (this.dependencyManager) {
            this.dependencyManager.shutdown()
            this.dependencyManager = null
        } else {
            this.logger.error("dependencyManager null")
        }
        return super.shutdown(params);
    }

    // TODO move out?
    private static _getDetailSymbol(symbol: SymbolInformation): DetailSymbolInformation {
        return {
            symbolInformation: symbol,
            contents: { kind: MarkupKind.PlainText, value: 'test' },
        }
    }

    public textDocumentFull(params: FullParams, span = new Span()): Observable<Operation> {
        const uri = normalizeUri(params.textDocument.uri)

        // Ensure files needed to resolve symbols are fetched
        const files = this.projectManager.ensureReferencedFiles(uri, undefined, undefined, span).toArray()

        const symbols: Observable<DetailSymbolInformation[]> = files
            .mergeMap(() => {
                const fileName = uri2path(uri)

                const config = this.projectManager.getConfiguration(fileName)
                config.ensureBasicFiles(span)
                const sourceFile = this._getSourceFile(config, fileName, span)
                if (!sourceFile) {
                    return []
                }
                const tree = config.getService().getNavigationTree(fileName)
                return observableFromIterable(walkNavigationTree(tree))
                    .filter(({ tree, parent }) => navigationTreeIsSymbol(tree))
                    .map(({ tree, parent }) =>
                        ExtendedTypescriptService._getDetailSymbol(
                            navigationTreeToSymbolInformation(tree, parent, sourceFile, this.root)
                        )
                    )
            })
            .toArray()

        const references: Observable<Reference[]> = files
            .mergeMap(() => {
                const fileName = uri2path(uri)

                const config = this.projectManager.getConfiguration(fileName)
                config.ensureBasicFiles(span)
                const sourceFile = this._getSourceFile(config, fileName, span)
                if (!sourceFile) {
                    return []
                }

                return (
                    observableFromIterable(walkMostAST(sourceFile))
                        // Filter Identifier Nodes
                        // TODO: include string-interpolated references
                        .filter((node): node is ts.Identifier => node.kind === ts.SyntaxKind.Identifier)
                        .mergeMap(node => {
                            try {
                                // Find definition for node
                                return Observable.from(
                                    config.getService().getDefinitionAtPosition(sourceFile.fileName, node.pos + 1) || []
                                )
                                    .mergeMap(definition => {
                                        const symbol = definitionInfoToSymbolDescriptor(definition, this.root)
                                        const uri = path2uri(definition.fileName)
                                        return this._getPackageDescriptor(uri, span)
                                            .defaultIfEmpty(undefined)
                                            .map(packageDescriptor => {
                                                symbol.package = packageDescriptor
                                                return symbol
                                            })
                                    })
                                    .map((symbolDescriptor: SymbolDescriptor): Reference => {
                                        const start = ts.getLineAndCharacterOfPosition(sourceFile, node.pos)
                                        const end = ts.getLineAndCharacterOfPosition(sourceFile, node.end)

                                        // TODO fix
                                        const symbolLoc: Location = {
                                            uri: symbolDescriptor.filePath, // convert to uri
                                            range: {
                                                start: { line: start.line, character: start.character },
                                                end: { line: start.line, character: start.character },
                                            },
                                        }

                                        return {
                                            category: ReferenceCategory.UNCATEGORIZED, // TODO add category
                                            symbol: {
                                                name: symbolDescriptor.name,
                                                kind: stringtoSymbolKind(symbolDescriptor.kind),
                                                location: symbolLoc,
                                            },
                                            location: {
                                                uri: locationUri(sourceFile.fileName),
                                                range: {
                                                    start: { line: start.line, character: start.character },
                                                    end: { line: end.line, character: end.character },
                                                },
                                            },
                                        }
                                    })
                            } catch (err) {
                                // Continue with next node on error
                                // Workaround for https://github.com/Microsoft/TypeScript/issues/15219
                                this.logger.error(
                                    `textdocument/xreferences: Error getting definition for ${
                                        sourceFile.fileName
                                    } at offset ${node.pos + 1}`,
                                    err
                                )
                                span.log({
                                    event: 'error',
                                    'error.object': err,
                                    message: err.message,
                                    stack: err.stack,
                                })
                                return []
                            }
                        })
                )
            })
            .toArray()

        return symbols
            .zip(references)
            .map(res => {
                const full: Full = { symbols: res[0], references: res[1] }
                return { op: 'add', path: '/-', value: full } as Operation
            })
            .startWith({ op: 'add', path: '', value: [] } as Operation)
    }
}
