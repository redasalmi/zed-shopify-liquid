'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_TIMEOUT = 30_000;

class ProtocolClient {
  constructor(args, { cwd = REPOSITORY_ROOT, configuration = {}, env = {}, workspaceRoot } = {}) {
    this.configuration = configuration;
    this.workspaceRoot = workspaceRoot;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = [];
    this.stderr = '';
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
    this.stopping = false;

    this.process = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stdout.on('data', (chunk) => this.#read(chunk));
    this.process.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
    this.process.on('error', (error) => this.#failAll(error));
    this.process.on('exit', (code, signal) => {
      if (!this.stopping) {
        this.#failAll(
          new Error(
            `language server exited unexpectedly (${signal || code})\n${this.stderr}`,
          ),
        );
      }
    });
  }

  #read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.expectedLength === null) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headers = this.buffer.subarray(0, headerEnd).toString();
        const length = /^Content-Length:\s*(\d+)$/im.exec(headers);
        assert(length, `missing Content-Length header in ${JSON.stringify(headers)}`);
        this.expectedLength = Number(length[1]);
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }
      if (this.buffer.length < this.expectedLength) return;

      const body = this.buffer.subarray(0, this.expectedLength).toString();
      this.buffer = this.buffer.subarray(this.expectedLength);
      this.expectedLength = null;
      this.#handle(JSON.parse(body));
    }
  }

  #handle(message) {
    if (message.method && message.id !== undefined) {
      this.#answerServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!message.method) return;
    const waiterIndex = this.notificationWaiters.findIndex(
      (waiter) => waiter.method === message.method && waiter.predicate(message.params),
    );
    if (waiterIndex !== -1) {
      const [waiter] = this.notificationWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    } else {
      this.notifications.push(message);
    }
  }

  #answerServerRequest(message) {
    let result = null;
    if (message.method === 'workspace/configuration') {
      result = (message.params?.items || []).map((item) =>
        valueAtPath(this.configuration, item.section),
      );
    } else if (message.method === 'workspace/workspaceFolders') {
      result = this.workspaceRoot
        ? [{ uri: pathToFileURL(this.workspaceRoot).href, name: path.basename(this.workspaceRoot) }]
        : [];
    } else if (message.method === 'workspace/applyEdit') {
      result = { applied: false };
    }
    this.send({ jsonrpc: '2.0', id: message.id, result });
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters = [];
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message));
    this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.process.stdin.write(body);
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method, params, timeout = DEFAULT_TIMEOUT) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}\n${this.stderr}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  waitForNotification(method, predicate = () => true, timeout = DEFAULT_TIMEOUT) {
    const queuedIndex = this.notifications.findIndex(
      (message) => message.method === method && predicate(message.params),
    );
    if (queuedIndex !== -1) {
      const [message] = this.notifications.splice(queuedIndex, 1);
      return Promise.resolve(message.params);
    }

    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.notificationWaiters.indexOf(waiter);
        if (index !== -1) this.notificationWaiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${method}\n${this.stderr}`));
      }, timeout);
      this.notificationWaiters.push(waiter);
    });
  }

  async initialize(capabilities = {}) {
    const rootUri = this.workspaceRoot ? pathToFileURL(this.workspaceRoot).href : null;
    const result = await this.request('initialize', {
      processId: null,
      rootUri,
      workspaceFolders: this.workspaceRoot
        ? [{ uri: rootUri, name: path.basename(this.workspaceRoot) }]
        : null,
      capabilities,
      initializationOptions: {},
    });
    this.notify('initialized', {});
    return result;
  }

  open(filePath, text, version = 1, languageId = 'liquid') {
    const uri = pathToFileURL(filePath).href;
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    });
    return uri;
  }

  change(uri, text, version) {
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  close(uri) {
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  async stop() {
    if (this.process.exitCode !== null) return;
    this.stopping = true;
    await this.request('shutdown', null, 5_000);

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.process.kill();
        resolve();
      }, 5_000);
      this.process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.notify('exit', null);
    });
  }
}

function valueAtPath(value, section) {
  if (!section) return value;
  let current = value;
  for (const part of section.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return null;
    current = current[part];
  }
  return current;
}

async function createTheme(files, { themeCheck = 'root: .\n' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zed-liquid-lsp-'));
  for (const directory of ['assets', 'blocks', 'config', 'layout', 'sections', 'snippets', 'templates']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, '.theme-check.yml'), themeCheck);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
  return {
    root,
    file(relativePath) {
      return path.join(root, relativePath);
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function embeddedClient(root, { env = {} } = {}) {
  return new ProtocolClient(
    ['--max-old-space-size=128', path.join(REPOSITORY_ROOT, 'language-server/embedded-javascript-server.cjs')],
    { env, workspaceRoot: root },
  );
}

function shopifyClient(root) {
  return new ProtocolClient(
    ['-e', "require('@shopify/theme-language-server-node').startServer()"],
    { workspaceRoot: root },
  );
}

function positionAt(text, offset) {
  const before = text.slice(0, offset);
  const lines = before.split(/\r?\n/);
  return { line: lines.length - 1, character: lines.at(-1).length };
}

function completionItems(result) {
  return Array.isArray(result) ? result : result?.items || [];
}

module.exports = {
  ProtocolClient,
  completionItems,
  createTheme,
  embeddedClient,
  positionAt,
  shopifyClient,
};
