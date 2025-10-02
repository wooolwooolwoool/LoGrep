import * as vscode from 'vscode';
import fs from "fs";
import path from "path";

function loadTemplate(name: string): string {
  try {
    let text = fs.readFileSync(path.join(__dirname, "../templates", `${name}.html`), "utf-8");
    return text;
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to load template: ${name}`);
    console.error(`Failed to load template: ${name}`, error);
    return `<html><body><h1>Error loading template: ${name}</h1></body></html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Grep extension is activated');

  const provider = new GrepInputViewProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('grepInputView', provider)
  );

  let disposable = vscode.commands.registerCommand('extension.grepWords', () => {
    vscode.window.showInformationMessage('Grep function triggered!');
  });

  context.subscriptions.push(disposable);
}

class GrepInputViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext // context を受け取る
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ) {
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this.getHtml();
    this.getSettingsList(webviewView.webview);
    const lastState = this.context.workspaceState.get<{ grepWords: string[], grepVWords: string[], searchWords: { word: string; color: string }[], settingName: string }>('lastState');
    if (lastState) {
      if (!lastState.grepVWords) {
        lastState.grepVWords = [];
      }
      webviewView.webview.postMessage({
        command: 'loadSettings',
        grepWords: lastState.grepWords,
        grepVWords: lastState.grepVWords,
        searchWords: lastState.searchWords,
        settingName: lastState.settingName
      });
    }

    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
      } else {
        this.restoreState(webviewView.webview);
        this.getSettingsList(webviewView.webview);
      }
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'grep') {
        this.grepInActiveEditor(message.grepWords, message.grepVWords, message.searchWords);
      } else if (message.command === 'saveSettings') {
        this.saveSettings(message.name, message.grepWords, message.grepVWords, message.searchWords, webviewView.webview);
      } else if (message.command === 'loadSettings') {
        this.loadSettings(message.name, webviewView.webview);
      } else if (message.command === 'deleteSetting') {
        this.deleteSetting(message.name, webviewView.webview);
      } else if (message.command === 'Logger') {
        this.Loggger(webviewView.webview, message.msg);
      } else if (message.command === 'saveSettings_current') {
        this.saveStateFromWebview(message.grepWords, message.grepVWords, message.searchWords, message.settingName, webviewView.webview);
      }
      webviewView.webview.postMessage({ command: 'Complete' });
    });
  }

  // state を保存するメソッド
  private async saveStateFromWebview(grepWords: string[], grepVWords: string[], searchWords: { word: string; color: string }[], settingName: string, webview: vscode.Webview) {
    const response = {grepWords: grepWords, grepVWords: grepVWords, searchWords: searchWords, settingName: settingName};
    if (response) {
      this.context.workspaceState.update('lastState', response);
      console.log('State saved:', response);
    }
  }

  // state を復元するメソッド
  private async restoreState(webview: vscode.Webview) {
    const state = this.context.workspaceState.get<any>('lastState');
    if (!state.grepVWords) {
      state.grepVWords = [];
    }
    if (state) {
      webview.postMessage({ command: 'loadSettings', grepWords: state.grepWords, grepVWords: state.grepVWords, searchWords: state.searchWords, settingName: state.settingName });
      console.log('State restored:', state);
    }
  }

  private async grepInActiveEditor(grepWords: string[], grepVWords: string[], searchWords: { word: string; color: string }[]) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found');
      return;
    }

    const doc = editor.document;
    let results: string[] = [];
    const grepWords_re: string[] = grepWords.filter(Boolean);
    const grepVWords_re: string[] = grepVWords.filter(Boolean);

    // 高速化のため条件を分岐
    if ( grepWords_re.length === 0 ) {
      // Grepワードが空の場合は-vのみ
      for (let line = 0; line < doc.lineCount; line++) {
        const text = doc.lineAt(line).text;
        if ( grepVWords_re.length === 0) {
          results.push(`${text}`);
        } else {
          if (!grepVWords_re.some(word => text.includes(word))) {
            results.push(`${text}`);
          }
        }
      }
    } else if (grepVWords_re.length === 0) {
      // -vワードが空の場合はGrepのみ
      for (let line = 0; line < doc.lineCount; line++) {
        const text = doc.lineAt(line).text;
        if (grepWords_re.some(word => text.includes(word))) {
          results.push(`${text}`);
        }
      }
    } else {
      // 両方ある場合
      for (let line = 0; line < doc.lineCount; line++) {
        const text = doc.lineAt(line).text;
        if (grepWords_re.some(word => text.includes(word))) {
          if (grepVWords_re.length === 0 || !grepVWords_re.some(word => text.includes(word))) {
            results.push(`${text}`);
          }
        }
      }
    }

    if (results.length > 0) {
      await this.showResultsInWebview(doc.fileName.split("/").slice(-1)[0], results, searchWords);
    } else {
      vscode.window.showInformationMessage('No matches found');
    }
  }

  private async showResultsInWebview(fileName: string, results: string[], searchWords: { word: string; color: string }[]) {
    const panel = vscode.window.createWebviewPanel(
      'grepResult',
      `Result ${fileName}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true }
    );

    // 1. 色ごとにクラスを生成
    const colorClassMap = new Map<string, string>();
    searchWords.forEach(({ color }, idx) => {
      if (!colorClassMap.has(color)) {
        colorClassMap.set(color, `highlight-${idx}`);
      }
    });

    // 2. 各行に強調spanを埋め込む
    // 特殊文字置換
    var result_join = results.join('\n')
          .replace(/&/g, '&amp;')   // 必ず最初に & を置換する
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
    searchWords.forEach(({ word, color }) => {
      const className = colorClassMap.get(color)!;
      // 正規表現で複数一致対応
      const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escapedWord, 'g');
      result_join = result_join .replace(regex, `<span class="highlight ${className}">${word}</span>`);
    });
    results = result_join.split('\n');
    const highlightedResults = results.map(line => {
      return `<div class="log-line">${line}</div>`;
    }).join('');

    // 3. CSS生成（背景は擬似要素で描画）
    const highlightCSS = Array.from(colorClassMap.entries()).map(([color, className]) => {
      return `
        .${className} {
          position: relative;
          display: inline;
        }
        .${className}::before {
          content: '';
          position: absolute;
          inset: 0;
          background-color: ${color};
          z-index: -1;
          border-radius: 2px;
        }
      `;
    }).join('\n');
    console.log("Try to load results template.");
    panel.webview.html = loadTemplate("results").replace('${highlightCSS}', highlightCSS).replace('${highlightedResults}', highlightedResults);
  }

  private async saveSettings(name: string, grepWords: string[], grepVWords: string[], searchWords: { word: string; color: string }[], webview: vscode.Webview) {
    const config = vscode.workspace.getConfiguration('grepExtension');
    const currentSettings = config.get<{ [key: string]: any }>('settings') || {};
    currentSettings[name] = { grepWords, grepVWords, searchWords };

    try {
      await config.update('settings', currentSettings, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Settings '${name}' saved`);

      // backup削除（正常に保存できた場合）
      await this.context.workspaceState.update('grepExtension_backup', undefined);
    } catch (error) {
      vscode.window.showInformationMessage(`Settings '${name}' saved to Backup`);

      // バックアップとして保存
      let backup = this.context.workspaceState.get<{ [key: string]: any }>('grepExtension_backup') || {};
      backup[name] = { grepWords, grepVWords, searchWords };
      await this.context.workspaceState.update('grepExtension_backup', backup);
    }

    this.getSettingsList(webview);
  }

  private async loadSettings(name: string, webview: vscode.Webview) {
    // まずバックアップがあるか確認し、あればそちらを優先
    const backup = this.context.workspaceState.get<{ [key: string]: any }>('grepExtension_backup');

    if (backup && backup[name]) {
      // vscode.window.showWarningMessage(`Loaded backup settings for '${name}'`);
      console.log(`Loaded backup settings for '${name}'`);
      if (!backup.grepVWords) {
        backup.grepVWords = [];
      }
      webview.postMessage({
        command: 'loadSettings',
        grepWords: backup[name].grepWords,
        grepVWords: backup[name].grepVWords,
        searchWords: backup[name].searchWords,
        settingName: name
      });
      return;
    }

    // 通常の設定を読み込む
    const config = vscode.workspace.getConfiguration('grepExtension').get<{ [key: string]: any }>('settings');
    if (config && config[name]) {
      if (!config[name].grepVWords) {
        config[name].grepVWords = [];
      }
      webview.postMessage({
        command: 'loadSettings',
        grepWords: config[name].grepWords,
        grepVWords: config[name].grepVWords,
        searchWords: config[name].searchWords,
        settingName: name
      });
    } else {
      vscode.window.showErrorMessage(`No settings found for '${name}'`);
    }
  }

  private async deleteSetting(name: string, webview: vscode.Webview) {
    if (!name) {
      vscode.window.showErrorMessage('No setting selected');
      return;
    }
    try {
      const config = vscode.workspace.getConfiguration('grepExtension');
      const currentSettings = config.get<{ [key: string]: any }>('settings') || {};
      if (currentSettings && currentSettings[name]) {
        currentSettings[name] = undefined;
        await config.update('settings', currentSettings, vscode.ConfigurationTarget.Global);
      }
    } catch {
      vscode.window.showErrorMessage(`Failed to delete settings '${name}'`);
    }
    try {
      const backup = this.context.workspaceState.get<{ [key: string]: any }>('grepExtension_backup') || {};
      if (backup && backup[name]) {
        backup[name] = undefined;
        await this.context.workspaceState.update('grepExtension_backup', backup);
      }
    } catch {
      vscode.window.showErrorMessage(`Failed to delete backup settings '${name}'`);
    }
    vscode.window.showInformationMessage(`Settings '${name}' deleted`);

    // 削除後に一覧を更新
    this.getSettingsList(webview);
    webview.postMessage({ command: 'Complete' });
  }


  // 設定名の一覧を取得してWebviewに送信
  private async getSettingsList(webview: vscode.Webview) {
    const config = vscode.workspace.getConfiguration('grepExtension').get<{ [key: string]: any }>('settings') || {};
    const settings = new Set(Object.keys(config));

    // バックアップの名前があれば追加
    const backup = this.context.workspaceState.get<{ [key: string]: any }>('grepExtension_backup') || {};
    if (backup) {
      Object.keys(backup).forEach(name => {
        settings.add(name);
      })
    }

    webview.postMessage({
      command: 'updateSettingsList',
      settings: Array.from(settings)
    });
  }

  private async Loggger(webview: vscode.Webview, msg: string) {
    vscode.window.showInformationMessage(`'${msg}'`);
    console.log(msg);
    console.log(vscode.window.activeColorTheme.kind);
  }

  private getHtml(): string {
    const lightColors = "['none', 'lightyellow', 'khaki', 'gold', 'lightsalmon', 'salmon', 'lightcoral', 'pink', 'hotpink', 'lightgreen', 'lime', 'aquamarine', 'skyblue', 'dodgerblue', 'fuchsia']";
    const darkColors = "['none', 'dimgray', 'slategray', 'darkolivegreen', 'olive', 'darkgreen', 'seagreen', 'teal', 'cadetblue', 'navy', 'indigo', 'purple', 'darkred', 'firebrick',  'chocolate', 'sienna', 'darkgoldenrod']";
    const Colors = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
      ? darkColors
      : lightColors;
    return loadTemplate("sidebar").replace("${Colors}", Colors);
  }
}

export function deactivate() {}
