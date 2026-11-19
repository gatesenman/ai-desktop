import { contextBridge, ipcRenderer, webUtils } from 'electron';

const INVOKE = new Set([
  'item:delete', 'item:rename', 'item:clip', 'fence:paste', 'fence:newFolder', 'fence:refresh', 'fence:tabMenu',
  'fence:init', 'fence:rename', 'fence:collapse', 'fence:setView', 'fence:menu', 'fence:undo',
  'fence:dragStart', 'fence:dragEnd', 'fence:peek', 'fence:endPeekAll', 'portal:nav', 'pager:go', 'pager:add',
  'rules:get', 'rules:set', 'rules:test', 'rules:apply', 'rules:describe', 'rules:fromText',
  'pages:get', 'pages:rename', 'pages:add', 'pages:delete', 'pages:go', 'snap:save', 'snap:restore', 'snap:delete', 'snap:rename',
  'hub:init', 'hub:organizePlan', 'hub:organizeApply', 'hub:cleanupScan', 'hub:cleanupApply', 'hub:renamePlan', 'hub:renameApply', 'hub:renameUndo', 'hub:briefing', 'hub:pickFiles', 'hub:reveal',
  'cmd:plan', 'cmd:run', 'content:search', 'content:status', 'content:rebuild',
  'appearance:get', 'appearance:set',
  'item:menu', 'item:open', 'item:reveal', 'icon:get', 'icon:getMany', 'drag:drop', 'drag:end',
  'search:query', 'search:ai', 'search:open', 'search:hide', 'search:resize',
  'chat:status', 'chat:send', 'chat:abort', 'chat:pickFile', 'chat:prepareFile', 'clipboard:write',
  'settings:get', 'settings:set', 'settings:test', 'settings:export', 'settings:import', 'onboard:finish',
  'app:action', 'toast:action', 'toast:close', 'theme:get',
  'win:hide', 'win:close', 'win:minimize', 'win:maximize', 'win:pin',
  // 1.2.6 (were missing from the allow-list -> renderer calls were blocked)
  'fence:tabSwitch', 'fence:tabAdd', 'fence:tabRename', 'fence:tabRemove',
  'hub:projectSpaces', 'hub:projectSpaceApply', 'corrections:list', 'corrections:delete', 'corrections:clear', 'corrections:makeRule',
  // 1.3.0
  'fence:areaMenu', 
]);
const SEND = new Set(['drag:native', 'drag:begin', 'drag:consume', 'fence:dragMove']);
const EVENTS = new Set([
  'fence:data', 'fence:startRename', 'theme', 'search:focus', 'chat:stream', 'chat:summarizeFile', 'chat:ask',
  'toast:show', 'toast:hide', 'settings:section',
  'fence:peek', 'fence:peekAll', 'fence:enter', 'fence:locked', 'guides', 'pager', 'settings:rules', 'settings:snapshots', 'hub:tab', 'content:progress',
  'fence:tabPromptRename', 'rb:update',
]);

const api = {
  invoke: (ch: string, ...args: unknown[]) => {
    if (!INVOKE.has(ch)) return Promise.reject(new Error('blocked channel ' + ch));
    return ipcRenderer.invoke(ch, ...args);
  },
  send: (ch: string, ...args: unknown[]) => {
    if (SEND.has(ch)) ipcRenderer.send(ch, ...args);
  },
  on: (ch: string, cb: (...args: any[]) => void) => {
    if (!EVENTS.has(ch)) return () => {};
    const h = (_e: unknown, ...a: any[]) => cb(...a);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
  pathForFile: (f: File): string => {
    try {
      return webUtils.getPathForFile(f);
    } catch {
      return (f as any).path ?? '';
    }
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
