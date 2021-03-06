#!/usr/bin/env node

import { FileLogger, StdioLogger } from 'javascript-typescript-langserver/lib/logging'
import { TypeScriptServiceOptions } from 'javascript-typescript-langserver/lib/typescript-service'
import { Tracer } from 'opentracing'
import { ExtendedTypescriptService } from './extended-typescript-service'
import { serve, ServeOptions } from './server'

const program = require('commander')
const packageJson = require('../package.json')
const { initTracer } = require('jaeger-client')

const defaultLspPort = 2089
const numCPUs = require('os').cpus().length

class FilteredStdioLogger extends StdioLogger {
    public warn(...values: any[]): void {
        if (typeof values[0] === 'string' && (values[0] as string).startsWith('TypeScript config file for')) {
            super.info(values)
        } else {
            super.warn(values)
        }
    }
}

program
    .version(packageJson.version)
    .option('-s, --strict', 'enabled strict mode')
    .option('-p, --port [port]', 'specifies LSP port to use (' + defaultLspPort + ')', parseInt)
    .option(
        '-c, --cluster [num]',
        'number of concurrent cluster workers (defaults to number of CPUs, ' + numCPUs + ')',
        parseInt
    )
    .option('-t, --trace', 'print all requests and responses')
    .option('-l, --logfile [file]', 'log to this file')
    .option('-j, --enable-jaeger', 'enable OpenTracing through Jaeger')
    .parse(process.argv)

const options: ServeOptions & TypeScriptServiceOptions = {
    clusterSize: program.cluster || numCPUs,
    lspPort: program.port || defaultLspPort,
    strict: program.strict,
    logMessages: program.trace,
    logger: program.logfile ? new FileLogger(program.logfile) : new FilteredStdioLogger(),
    tracer: program.enableJaeger
        ? initTracer({ serviceName: 'javascript-typescript-langserver', sampler: { type: 'const', param: 1 } })
        : new Tracer(),
}

serve(options, client => new ExtendedTypescriptService(client, options))
