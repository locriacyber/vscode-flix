import { InitializeParams, InitializeResult, TextDocumentSyncKind } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'

import * as jobs from '../engine/jobs'
import * as queue from '../engine/queue'
import * as engine from '../engine'
import * as socket from '../engine/socket'

import { clearDiagnostics, sendDiagnostics, sendNotification } from '../server'
import { makePositionalHandler, makeEnqueuePromise } from './util'

const _ = require('lodash/fp')

interface UriInput {
  uri: string
}

export function handleInitialize (_params: InitializeParams) {
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      codeLensProvider: {
        resolveProvider: true
      }
    }
  }
  return result
}

/**
 * Runs when both client and server are ready.
 */
export function handleReady (engineInput: engine.StartEngineInput) {
  engine.start(engineInput)
}

export function handleAddUri ({ uri }: UriInput) {
  engine.addUri(uri)
}

export function handleRemUri ({ uri }: UriInput) {
  engine.remUri(uri)
}

export function handleExit () {
  engine.stop()
}

export function handleChangeContent (params: any) {
  const document: TextDocument = params.document
  const job: jobs.Job = {
    request: jobs.Request.apiAddUri,
    uri: document.uri, // Note: this typically has the file:// scheme (important for files as keys)
    src: document.getText()
  }
  queue.enqueue(job)
  queue.enqueue(jobs.createCheck())
}

/**
 * @function
 */
export const handleGotoDefinition = makePositionalHandler(jobs.Request.lspGoto)

/**
 * @function
 */
export const handleHover = makePositionalHandler(jobs.Request.lspHover)

/**
 * @function
 */
export const handleReferences = makePositionalHandler(jobs.Request.lspUses)

/**
 * @function
 */
export const handleCodelens = makePositionalHandler(jobs.Request.lspCodelens)

function makeRunBenchmarksResponseHandler (promiseResolver: Function) {
  return function responseHandler ({ status, result }: socket.FlixResponse, ) {
    if (status === 'success') {
      promiseResolver(result)
    } else {
      promiseResolver()
    }
  }
}

/**
 * @function
 */
export const handleRunBenchmarks = makeEnqueuePromise(jobs.Request.cmdRunBenchmarks, makeRunBenchmarksResponseHandler)

function makeRunMainResponseHandler (promiseResolver: Function) {
  return function responseHandler ({ status, result }: socket.FlixResponse, ) {
    if (status === 'success') {
      promiseResolver(result)
    } else {
      promiseResolver()
    }
  }
}

/**
 * @function
 */
export const handleRunMain = makeEnqueuePromise(jobs.Request.cmdRunMain, makeRunMainResponseHandler)

function makeRunTestsResponseHandler (promiseResolver: Function) {
  return function responseHandler ({ status, result }: socket.FlixResponse, ) {
    if (status === 'success') {
      promiseResolver(result)
    } else {
      promiseResolver()
    }
  }
}

/**
 * @function
 */
export const handleRunTests = makeEnqueuePromise(jobs.Request.cmdRunTests, makeRunTestsResponseHandler)

function makeVersionResponseHandler (promiseResolver: Function) {
  return function responseHandler ({ status, result }: any) {
    if (status === 'success') {
      const { major, minor, revision } = result
      const message = `Running Flix (${major}.${minor}-rev${revision})`
      sendNotification(jobs.Request.internalMessage, message)
    } else {
      sendNotification(jobs.Request.internalError, 'Failed starting Flix')
    }
    promiseResolver()
  }
}

/**
 * @function
 */
export const handleVersion = makeEnqueuePromise(jobs.Request.apiVersion, makeVersionResponseHandler)

/**
 * Handle response from lsp/check
 * 
 * This is different from the rest of the response handlers in that it isn't tied together with its enqueueing function.
 */
export function lspCheckResponseHandler ({ status, result }: socket.FlixResponse, ) {
  clearDiagnostics()
  if (status !== 'success') {
    _.each(sendDiagnostics, result)
  }
}
