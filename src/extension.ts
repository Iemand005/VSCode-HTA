// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
const ts = require('typescript');

const collection = vscode.languages.createDiagnosticCollection('hta');
const SCRIPT_RE = /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi;
/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();

const blank = (/** @type {string} */ s) => s.replace(/[^\r\n]/g, ' ');

/**
 * Keep only JS script bodies; blank everything else so offsets stay identical.
 * Skips external (src), for/event handler and VBScript blocks.
 */
function extractScripts(/** @type {string} */ text) {
  let out = '', last = 0, m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(text))) {
    const open = m[1], body = m[2];
    const skip = /\bsrc\s*=/i.test(open) || /\bfor\s*=/i.test(open) || /language\s*=\s*["']?vbscript/i.test(open);
    const bodyStart = m.index + open.length;
    out += blank(text.slice(last, bodyStart)) + (skip ? blank(body) : body);
    last = bodyStart + body.length;
  }
  return out + blank(text.slice(last));
}

function check(/** @type {vscode.TextDocument} */ doc) {
  if (!doc.fileName.toLowerCase().endsWith('.hta')) return;
  if (!vscode.workspace.getConfiguration('hta').get('diagnostics.enable', true)) {
    collection.delete(doc.uri);
    return;
  }

  const norm = (/** @type {string} */ p) => p.replace(/\\/g, '/');
  const virtual = norm(doc.fileName) + '.js';
  const text = extractScripts(doc.getText());

  /** @type {ts.CompilerOptions} */
  let options = { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES5, lib: ['lib.dom.d.ts', 'lib.es5.d.ts'] };
  /** @type {string[]} */
  let extra = [];

  const cfgPath = ts.findConfigFile(norm(path.dirname(doc.fileName)), ts.sys.fileExists, 'jsconfig.json');
  if (cfgPath) {
    const cfg = ts.getParsedCommandLineOfConfigFile(
      cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
    );
    if (cfg) {
      options = { ...cfg.options, allowJs: true, checkJs: true, noEmit: true };
      extra = cfg.fileNames.filter(f => norm(f) !== virtual);
    }
  }

  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = f => norm(f) === virtual || fileExists.call(host, f);
  host.readFile = f => (norm(f) === virtual ? text : readFile.call(host, f));
  host.getSourceFile = (f, lang, ...rest) =>
    norm(f) === virtual ? ts.createSourceFile(f, text, lang) : getSourceFile.call(host, f, lang, ...rest);

  const program = ts.createProgram([virtual, ...extra], options, host);
  const sf = program.getSourceFile(virtual);
  if (!sf) return;

  const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
  collection.set(doc.uri, diags
    .filter(d => d.start !== undefined)
    .map(d => {
      const start = doc.positionAt(d.start ?? 0);
      const end = doc.positionAt((d.start ?? 0) + (d.length ?? 0));
      const diag = new vscode.Diagnostic(
        new vscode.Range(start, end),
        ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        d.category === ts.DiagnosticCategory.Error ? vscode.DiagnosticSeverity.Error
          : d.category === ts.DiagnosticCategory.Warning ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information
      );
      diag.source = 'hta';
      diag.code = d.code;
      return diag;
    }));
}

function schedule(/** @type {vscode.TextDocument} */ doc, delay = 600) {
  const key = doc.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { try { check(doc); } catch (e) { console.error('[hta]', e); } }, delay));
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "hta" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('hta.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from hta!');
	});

	context.subscriptions.push(disposable);

	context.subscriptions.push(
		collection,
		vscode.workspace.onDidOpenTextDocument(d => schedule(d, 0)),
		vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
		vscode.workspace.onDidSaveTextDocument(d => schedule(d, 0)),
		vscode.workspace.onDidCloseTextDocument(d => collection.delete(d.uri)),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('hta')) vscode.workspace.textDocuments.forEach(d => schedule(d, 0));
		})
	);
  vscode.workspace.textDocuments.forEach(d => schedule(d, 0));
}

// This method is called when your extension is deactivated
export function deactivate() {}
