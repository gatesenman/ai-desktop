export type Category = 'doc' | 'image' | 'video' | 'audio' | 'archive' | 'program' | 'folder' | 'other';

export const CATEGORY_LABEL: Record<Category, string> = {
  doc: '文档',
  image: '图片',
  video: '视频',
  audio: '音频',
  archive: '压缩包',
  program: '程序/快捷方式',
  folder: '文件夹',
  other: '其他',
};

export const CATEGORY_ORDER: Category[] = ['program', 'folder', 'doc', 'image', 'video', 'audio', 'archive', 'other'];

/** Remix Icon class per category (icon font, bundled locally). */
export const CATEGORY_ICON: Record<Category, string> = {
  doc: 'ri-file-text-line',
  image: 'ri-image-line',
  video: 'ri-film-line',
  audio: 'ri-music-2-line',
  archive: 'ri-file-zip-line',
  program: 'ri-apps-2-line',
  folder: 'ri-folder-3-line',
  other: 'ri-shapes-line',
};

export const CATEGORY_COLOR: Record<Category, string> = {
  doc: '#4f7cff',
  image: '#e5579a',
  video: '#ef5350',
  audio: '#9b6bff',
  archive: '#f08c2e',
  program: '#2f9bff',
  folder: '#e8a92c',
  other: '#7b8798',
};

export const BOX_COLORS: { name: string; value: string }[] = [
  { name: '默认', value: '' },
  { name: '天蓝', value: '#2f9bff' },
  { name: '靛蓝', value: '#4f7cff' },
  { name: '紫罗兰', value: '#9b6bff' },
  { name: '玫红', value: '#e5579a' },
  { name: '珊瑚红', value: '#ef5350' },
  { name: '橙', value: '#f08c2e' },
  { name: '琥珀', value: '#e8a92c' },
  { name: '青绿', value: '#14b8a6' },
  { name: '草绿', value: '#3dbb63' },
  { name: '石板灰', value: '#7b8798' },
];

export const BOX_ICONS: string[] = [
  'ri-inbox-2-line', 'ri-folder-3-line', 'ri-file-text-line', 'ri-image-line', 'ri-film-line', 'ri-music-2-line',
  'ri-file-zip-line', 'ri-apps-2-line', 'ri-star-line', 'ri-briefcase-4-line', 'ri-book-open-line', 'ri-code-s-slash-line',
  'ri-gamepad-line', 'ri-download-2-line', 'ri-time-line', 'ri-heart-3-line', 'ri-bookmark-line', 'ri-rocket-2-line',
  'ri-palette-line', 'ri-stack-line', 'ri-archive-line', 'ri-team-line', 'ri-shopping-bag-3-line', 'ri-sparkling-2-line',
  'ri-graduation-cap-line', 'ri-camera-line', 'ri-tools-line', 'ri-global-line', 'ri-money-cny-circle-line', 'ri-shapes-line',
];

export interface DesktopItem {
  path: string;
  name: string; // display name (no .lnk/.url)
  ext: string; // lower-case, with dot
  isDir: boolean;
  size: number;
  mtime: number; // ms
  category: Category;
  source: 'user' | 'public' | 'external' | 'portal';
}

export type SortMode = 'manual' | 'name' | 'date' | 'type' | 'size';
export type ViewMode = 'grid' | 'list';
export type BoxKind = 'normal' | 'recent' | 'portal' | 'manual';
export type PortalSync = 'mirror' | 'bidirectional';
export type DropMode = 'reference' | 'ask' | 'copy' | 'move';
export type TitleStyle = 'band' | 'minimal' | 'accent';
export type TitleAlign = 'center' | 'left';

export interface FenceTab {
  id: string;
  title: string;
  items: string[];
  color?: string; // v1.3.2: per-tab colour (Fences 6)
}
export type TabStyle = 'pill' | 'underline' | 'classic';

export interface BoxState {
  id: string;
  title: string;
  /** rule category of this box; null = user / AI created box */
  category: Category | null;
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
  items: string[]; // file paths, ordered (manual order)
  color?: string; // accent hex, '' = theme default
  icon?: string; // remix icon class
  view?: ViewMode;
  sort?: SortMode;
  kind?: BoxKind; // 'recent' | 'portal' | 'manual' (empty custom container) | 'normal'
  /** Folder Portal: mirrored folder + current sub folder + sync mode */
  portal?: { root: string; cwd?: string; sync?: PortalSync };
  /** How Explorer/desktop drops enter a manual/normal box (default reference). */
  dropMode?: DropMode;
  page?: number; // desktop page index (0-based)
  locked?: boolean; // no move / resize
  keepOnHide?: boolean; // stays visible on quick-hide (double-click desktop)
  tint?: number; // 0..1 how strongly the accent color tints the panel (Fences-style colored fence)
  alpha?: number; // panel opacity override 0.15..1 (undefined = global)
  iconTint?: boolean; // Fences 6 "Icon Tint": colorize icons with the accent
  titleStyle?: TitleStyle;
  titleAlign?: TitleAlign;
  /** Fence Tabs: multiple named piles inside one fence (Fences-style tab groups). */
  tabs?: FenceTab[];
  activeTabId?: string;
  /** v1.3 Fences parity */
  titleFont?: string; // CSS font-family for the title ('' = system)
  titleSize?: number; // px
  titleColor?: string;
  iconSizeOverride?: number; // per-fence icon size (px)
  /** v1.3.2 Fences parity */
  tabStyle?: TabStyle;
  hideTitleIcon?: boolean; // hide the folder/fence icon on the title bar (Fences 5.91)
}

/** User editable auto-sort rule (Fences-style). Rules are evaluated top-down; first match wins. */
export type RuleField = 'ext' | 'name' | 'regex' | 'category' | 'modified' | 'size' | 'kind' | 'target' | 'weekday' | 'hour';
export interface RuleCond {
  field: RuleField;
  /** ext: in · name: contains|starts|ends|glob · regex: matches · category: is · modified: older|newer (days) · size: gt|lt (MB) · kind: folder|shortcut|file · target (shortcut target path): contains|notcontains|starts|ends · weekday: in (1-5,7) · hour: in (9-18) */
  op: string;
  value: string;
}
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  match: 'all' | 'any';
  conds: RuleCond[];
  target: string; // target box title (created when missing)
  color?: string;
  icon?: string;
  source?: 'user' | 'ai' | 'learned' | 'default';
}

export interface Snapshot {
  id: string;
  name: string;
  at: number;
  resolution: string;
  auto?: boolean;
  boxes: BoxState[];
  pages: string[];
}

export interface Layout {
  version: 1;
  boxes: BoxState[];
  hidden: boolean;
  pages?: string[]; // desktop page names
  page?: number; // current page
}

export type ThemeMode = 'auto' | 'dark' | 'light';

export interface AISettings {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface Settings {
  ai: AISettings;
  theme: ThemeMode;
  opacity: number; // 0.3 - 1
  iconSize: number; // px
  autoStart: boolean;
  hotkeySearch: string;
  hotkeyChat: string;
  hotkeyToggle: string;
  embedDesktop: boolean; // Windows: attach to desktop layer (experimental)
  keepBottom: boolean; // Windows: push boxes to bottom of z-order when they lose focus
  dblClickDesktop: boolean; // Windows: double-click empty desktop toggles boxes
  desktopContextMenu: boolean; // Windows: register cascading menu on desktop background right-click
  acrylic: boolean; // Windows 11: system acrylic material
  scanPublicDesktop: boolean;
  recentCount: number;
  onboarded: boolean;
  // --- Fences-style behaviour (v1.2)
  rollupOn: 'click' | 'dblclick'; // title bar action that rolls a fence up
  hoverPeek: boolean; // hovering a rolled-up fence expands it temporarily
  snapGrid: number; // 0 = off
  snapEdges: boolean; // snap to other fences / screen edges, with guides
  hideIcons: boolean; // Windows: quick-hide also hides the system desktop icons
  chameleon: boolean; // icons fade until the mouse comes near
  hotkeyPeek: string; // bring fences on top of windows
  hotkeyPageNext: string;
  hotkeyPagePrev: string;
  autoResolution: boolean; // remember a layout per screen resolution
  rules: Rule[];
  autoPlace: boolean; // apply rules to new desktop files
  learnFromMoves: boolean; // suggest rules from manual corrections
  learnRuleMin: number;
  // --- v1.3 Fences parity
  drawFence: 'right' | 'left' | 'off'; // drag on empty desktop draws a new fence
  desktopRightClick: 'app' | 'explorer'; // empty-desktop right click: our menu (primary) or the Windows one
  nativeItemMenu: boolean; // file right-click inside fences shows the real Explorer context menu
  quickHideMode: 'all' | 'fences' | 'icons'; // what double-click quick-hide hides
  headerMode: 'always' | 'hover'; // show fence title bars always / on mouse-over
  hideScrollbars: boolean; // hide scrollbars while the fence is not hovered
  iconMultiples: boolean; // keep fences sized to whole icon cells when resizing
  groupGap: number; // px gap kept between fences when snapping // suggest rule after N same-ext corrections (default 3)
  tintAll: boolean; // Fences 6 icon tint for every fence
  tintColor: string; // '' = theme accent
  tintStrength: number; // 0..1
  dailyBriefing: boolean;
  contentIndex: boolean; // local full-text index for content search
  embedModel: string; // optional embeddings model for semantic search ('' = off)
}

export interface SearchResult extends DesktopItem {
  score: number;
  reason?: string;
  hl?: number[]; // indices of matched chars in name
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ThemePayload {
  theme: 'dark' | 'light';
  opacity: number;
  iconSize: number;
  acrylic?: boolean;
  chameleon?: boolean;
  rollupOn?: 'click' | 'dblclick';
  hoverPeek?: boolean;
  headerMode?: 'always' | 'hover';
  hideScrollbars?: boolean;
  /** v1.3.2: Fences 6 global icon tint (all fences) */
  tintAll?: boolean;
  tintColor?: string;
  tintStrength?: number;
}

export interface FenceData extends ThemePayload {
  box: BoxState;
  items: DesktopItem[];
  canUndo: boolean;
  /** portal breadcrumb (root first) */
  crumbs?: { name: string; path: string }[];
  portalError?: string;
}

export interface CleanupItem extends DesktopItem {
  reason: string;
  group: 'duplicate' | 'stale' | 'large' | 'installer' | 'empty' | 'temp';
  dupOf?: string;
}

export interface RenameProposal {
  path: string;
  from: string;
  to: string;
  reason?: string;
}

/** AI command bar action (validated in main before running) */
export interface CmdAction {
  type:
    | 'organize' | 'ai-organize' | 'create-box' | 'move' | 'create-rule' | 'hide' | 'show' | 'page'
    | 'snapshot-save' | 'snapshot-restore' | 'cleanup' | 'rename' | 'briefing' | 'summarize' | 'search' | 'settings' | 'portal' | 'undo';
  box?: string;
  query?: string;
  files?: string[];
  rule?: Rule;
  page?: number;
  name?: string;
  text?: string;
  label?: string;
}

export interface StreamEvent {
  id: string;
  delta?: string;
  done?: boolean;
  error?: string;
}

export interface ToastPayload {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
  action?: { label: string; command: string };
  timeout?: number;
}
