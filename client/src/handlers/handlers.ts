import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { quote } from 'shell-quote'

import * as jobs from '../engine/jobs'
import * as timers from '../services/timers'
import eventEmitter from '../services/eventEmitter'
import ensureFlixExists from './../util/ensureFlixExists'
import { LaunchOptions, defaultLaunchOptions, FLIX_GLOB_PATTERN, FPKG_GLOB_PATTERN } from './../extension'

const _ = require('lodash/fp')

let countTerminals:number = 0

export function makeHandleRunJob (
  client: LanguageClient,
  request: jobs.Request
) {
  return function handler () {
    client.sendNotification(request)
  }
}

/**
 * returns an active terminal with prefix name `flix`.
 * 
 * If not any active terminal with prefix name `flix`, it creates a new terminal with name `flix`.
 *
 * @return vscode.Terminal
*/
function getFlixTerminal() {
    const activeTerminals = vscode.window.terminals
    for (const element of activeTerminals) {
        if(element.name.substring(0, 4) == `flix`)
            return element
    }
    const terminal = vscode.window.createTerminal(`flix-`+countTerminals.toString())
    countTerminals+=1 //creating a new terminal since no active flix terminals available.
    return terminal
}


/**
 * returns an new active terminal with prefix name `flix`.
 * 
 * If not any active terminal with prefix name `flix`, it creates a new terminal with name `flix` and returns it.
 *
 * If there are already `n` active terminals exist with prefix name `flix`, it creates a new terminal with name `flix n+1`
 *
 * @return vscode.Terminal
*/
function newFlixTerminal() {
    const terminal = vscode.window.createTerminal(`flix-`+countTerminals.toString())
    countTerminals+=1
    return terminal
}

/**
 * an array of string arguments entered by user in flix extension settings `Extra Flix Args`.
 * @returns string[]
 */

function getExtraFlixArgs() {
    const arg:string = vscode.workspace.getConfiguration('flix').get('extraFlixArgs')
    return arg.split(' ')
}
/**
 * takes a string and a terminal and passes that string to the terminal.
 *
 * @param cmd string (a terminal command) to pass to the terminal.
 *
 * @param terminal vscode.Terminal 
 *
 * @return void
*/
function passCommandToTerminal(cmd:string[], terminal: vscode.Terminal) {
    terminal.show()
    terminal.sendText(quote(cmd))
}

/**
 * Opens an input box to ask the user for input.
 * uses the `vscode.window.showInputBox` function with custom `prompt` and `placeHolder` and value of `ignoreFocusOut` to be `true`.
 *
 *
 * @return A promise that resolves to a string the user provided or to `undefined` in case of dismissal.
*/
async function takeInputFromUser() {
    const input = await vscode.window.showInputBox({
        prompt: "Enter arguments separated by spaces",
        placeHolder: "arg0 arg1 arg2 ...",
		ignoreFocusOut: true
    })
    return input
}

async function handleUnsavedFiles() {
    let unsaved = []
    const textDocuments = vscode.workspace.textDocuments
    for (const textDocument of textDocuments) {
        if(textDocument.isDirty)
            unsaved.push(textDocument)
    }
    if (unsaved.length != 0) {
        const msg = "The workspace contains unsaved files. Do you want to save?"
        const option1 = 'Run without saving'
        const option2 = 'Save all and run'
        const action = await vscode.window.showWarningMessage(msg, option1, option2)
        if(action == option2)
            await vscode.workspace.saveAll(false)
    }
}

/**
 * combines the paths of all flix files present in the current directory of vscode window.
 * 
 * gets an array of vscode.Uri for all flix files using `vscode.workspace.findFiles` function
 *
 * @return string of format "\<path_to_first_file\>" "\<path_to_second_file\>" ..........
*/
async function getFiles() {
    await handleUnsavedFiles()
    const flixFiles = await vscode.workspace.findFiles(FLIX_GLOB_PATTERN)
    const fpkgFiles = await vscode.workspace.findFiles(FPKG_GLOB_PATTERN)
    let files = []
    files.push(...flixFiles)
    files.push(...fpkgFiles)
    return files.map(x => x.fsPath)
}

/**
 * sends a java command to compile and run flix program of vscode window to the terminal.
 * 
 * @param terminal vscode.Terminal
 * @param args string
 * @param context vscode.ExtensionContext
 * @param launchOptions LaunchOptions
 */
async function passArgs (
    terminal:vscode.Terminal,
    args: string,
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions,
    entryPoint?: string
    ) {
        let cmd = await getJVMCmd(context, launchOptions, entryPoint)
        cmd.push(...await getFiles())
        if(args.trim().length != 0) {
            cmd.push("--args")
            cmd.push(args)
        }
        cmd.push(...getExtraFlixArgs())
        passCommandToTerminal(cmd, terminal)  
}

/**
 * It takes context and launchOptions as arguments and finds the path of `flix.jar`
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LauchOptions
 * 
 * @returns string (path of `flix.jar`)
 */
async function getFlixFilename(context:vscode.ExtensionContext, launchOptions: LaunchOptions) {
    const globalStoragePath = context.globalStoragePath
    const workspaceFolders = _.map(_.flow(_.get('uri'), _.get('fsPath')), vscode.workspace.workspaceFolders)
    return await ensureFlixExists({ globalStoragePath, workspaceFolders, shouldUpdateFlix: launchOptions.shouldUpdateFlix })
}


/**
 * generate a java command to compile the flix program.
 * @param context vscode.ExtensionContext
 * @param launchOptions LaunchOptions
 * @returns string[]
 */
 async function getJVMCmd(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions,
    entryPoint?: string
    ) {
        const flixFilename = await getFlixFilename(context, launchOptions)
        const jvm:string = vscode.workspace.getConfiguration('flix').get('extraJvmArgs')
        let cmd = ['java']
        if(jvm.length != 0)
        cmd.push(...jvm.split(' '))
        cmd.push(...['-jar', flixFilename])
        if (entryPoint && entryPoint.length > 0) {
            cmd.push(...['--entrypoint', entryPoint])
        }
        return cmd
}

/**
 * Run main without any custom arguments
 * 
 * Sends command `java -jar <path_to_flix.jar> <paths_to_all_flix_files>` to an existing (if already exists else new) terminal.
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @return function handler
*/

export function runMain(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler (entryPoint) {
            let cmd = await getJVMCmd(context, launchOptions, entryPoint)
            cmd.push(...await getFiles())
            let terminal = getFlixTerminal()
            cmd.push(...getExtraFlixArgs())
            passCommandToTerminal(cmd, terminal)  
        }
}

/**
 * Run main with user provided arguments
 * 
 * Sends command `java -jar <path_to_flix.jar> <paths_to_all_flix_files> --args <arguments>` to an existing (if already exists else new) terminal.
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @return function handler
*/
export function runMainWithArgs(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler (entryPoint) {
            let input = await takeInputFromUser()
            if(input != undefined)
            {
                let terminal = getFlixTerminal()
                await passArgs(terminal, input, context, launchOptions, entryPoint)
            }
        }
}

/**
 * Run main without any custom arguments in a new terminal
 * 
 * Sends command `java -jar <path_to_flix.jar> <paths_to_all_flix_files>` to a new terminal.
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @return function handler
*/
export function runMainNewTerminal(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler (entryPoint) {
            let terminal = newFlixTerminal()
            let cmd = await getJVMCmd(context, launchOptions, entryPoint)
            cmd.push(...await getFiles())
            cmd.push(...getExtraFlixArgs())
            passCommandToTerminal(cmd, terminal)
        }
}


/**
 * Run main with user provided arguments in a new terminal
 * 
 * Sends command `java -jar <path_to_flix.jar> <paths_to_all_flix_files> --args <arguments>` to a new terminal.
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @return function handler
*/
export function runMainNewTerminalWithArgs(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler (entryPoint) {
            let input = await takeInputFromUser()
            if(input != undefined)
            {
                let terminal = newFlixTerminal()
                await passArgs(terminal, input, context, launchOptions, entryPoint)
            }
        }
}

export function makeHandleRunJobWithProgress (
  client: LanguageClient, 
  outputChannel: vscode.OutputChannel, 
  request: jobs.Request, 
  title: string, 
  timeout: number = 180
) {
  return function handler () {
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false
    }, function (_progress) {
      return new Promise(function resolver (resolve, reject) {
        client.sendNotification(request)

        const cancelCleanup = timers.ensureCleanupEventually(reject, timeout)
  
        eventEmitter.on(jobs.Request.internalFinishedJob, function readyHandler () {
          cancelCleanup()
          outputChannel.show()
          resolve(undefined)
        })
      })
    })
  }
}


/**
 * Returns a terminal with the given name (new if already not exists)
 * 
 * @param name name of the terminal
 * 
 * @returns vscode.Terminal
 */

function getTerminal(name: string) {
    const activeTerminals = vscode.window.terminals
    for (const element of activeTerminals) {
        if(element.name == name)
            return element
    }
    return vscode.window.createTerminal({name: name})
}



/**
 * creates a new project in the current directory using command `java -jar flix.jar init`
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @returns function handler
 */
 export function cmdInit(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler () {
            let cmd = await getJVMCmd(context, launchOptions)
            cmd.push('init')
            let terminal = getTerminal('init')
            cmd.push(...getExtraFlixArgs())
            await handleUnsavedFiles()
            passCommandToTerminal(cmd, terminal)
        }
}

/**
 * checks the current project for errors using command `java -jar flix.jar check`
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @returns function handler
 */

export function cmdCheck(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler () {
            let cmd = await getJVMCmd(context, launchOptions)
            cmd.push('check')
            let terminal = getTerminal('check')
            cmd.push(...getExtraFlixArgs())
            await handleUnsavedFiles()
            passCommandToTerminal(cmd, terminal)
        }
}

/**
 * builds (i.e. compiles) the current project using command `java -jar flix.jar build`
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @returns function handler
 */
export function cmdBuild(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler () {
            let cmd = await getJVMCmd(context, launchOptions)
            cmd.push('build')
            let terminal = getTerminal('build')
            cmd.push(...getExtraFlixArgs())
            await handleUnsavedFiles()
            passCommandToTerminal(cmd, terminal)
        }
}

/**
 * builds a jar-file from the current project using command `java -jar flix.jar build-jar`
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @returns function handler
 */
export function cmdBuildJar(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler () {
            let cmd = await getJVMCmd(context, launchOptions)
            cmd.push('build-jar')
            let terminal = getTerminal('build-jar')
            cmd.push(...getExtraFlixArgs())
            await handleUnsavedFiles()
            passCommandToTerminal(cmd, terminal)
        }
}

/**
 * builds a fpkg-file from the current project using command `java -jar flix.jar build-pkg`
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @returns function handler
 */
export function cmdBuildPkg(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler () {
            let cmd = await getJVMCmd(context, launchOptions)
            cmd.push('build-pkg')
            let terminal = getTerminal('build-pkg')
            cmd.push(...getExtraFlixArgs())
            await handleUnsavedFiles()
            passCommandToTerminal(cmd, terminal)
        }
}

/**
 * runs main for the current project using command `java -jar flix.jar run`
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @returns function handler
 */
export function cmdRunProject(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler () {
            let cmd = await getJVMCmd(context, launchOptions)
            cmd.push('run')
            let terminal = getTerminal('run')
            cmd.push(...getExtraFlixArgs())
            await handleUnsavedFiles()
            passCommandToTerminal(cmd, terminal)
        }
}

/**
 * runs the benchmarks for the current project using command `java -jar flix.jar benchmark`
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @returns function handler
 */
export function cmdBenchmark(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler () {
            let cmd = await getJVMCmd(context, launchOptions)
            cmd.push('benchmark')
            let terminal = getTerminal('benchmark')
            cmd.push(...getExtraFlixArgs())
            await handleUnsavedFiles()
            passCommandToTerminal(cmd, terminal)
        }
}

/**
 * runs all the tests for the current project using command `java -jar flix.jar test`
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @returns function handler
 */
export function cmdTests(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler () {
            let cmd = await getJVMCmd(context, launchOptions)
            cmd.push('test')
            let terminal = getTerminal('test')
            cmd.push(...getExtraFlixArgs())
            await handleUnsavedFiles()
            passCommandToTerminal(cmd, terminal)
        }
}

/**
 * runs the custom tests for the current project using command `java -jar flix.jar test <test01> <test02> ...`
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @returns function handler
 */
export function cmdTestWithFilter(
    context: vscode.ExtensionContext, 
    launchOptions: LaunchOptions = defaultLaunchOptions
    ) {
        return async function handler () {
            let cmd = await getJVMCmd(context, launchOptions)
            cmd.push('test')
            const input = await vscode.window.showInputBox({
                prompt: "Enter names of test functions separated by spaces",
                placeHolder: "test01 test02 ...",
                ignoreFocusOut: true
            })
            if(input != undefined)
            {
                cmd.push(input)
                let terminal = getTerminal('testWithFilter')
                cmd.push(...getExtraFlixArgs())
                await handleUnsavedFiles()
                passCommandToTerminal(cmd, terminal)
            }
        } 
}

/**
 * runs a repl for the current project using command `java -jar flix.jar repl`
 * 
 * @param context vscode.ExtensionContext
 * 
 * @param launchOptions LaunchOptions
 * 
 * @returns function handler
 */
 export function cmdRepl(
  context: vscode.ExtensionContext, 
  launchOptions: LaunchOptions = defaultLaunchOptions
  ) {
      return async function handler () {
          let cmd = await getJVMCmd(context, launchOptions)
          cmd.push('repl')
          let terminal = getTerminal('repl')
          cmd.push(...getExtraFlixArgs())
          await handleUnsavedFiles()
          passCommandToTerminal(cmd, terminal)
      }
}
