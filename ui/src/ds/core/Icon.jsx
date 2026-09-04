// Foreman adaptation of the design system's Icon: same API and semantic map,
// but rendered with the `lucide-react` npm package instead of the Lucide UMD
// the design deliverable loads from a CDN (self-contained builds, no layout
// shift, tree-shaken to the icons actually named below).
import React from 'react';
import {
  Circle, Activity, Check, X, Pause, WifiOff, History, TriangleAlert, OctagonAlert,
  RotateCw, Bot, Plus, CornerLeftUp, ArrowLeft, Folder, Bell, Unlink, Sun, Moon,
  Clock, AlignLeft, Users, ChevronDown, ChevronRight, Braces, MessageCircleQuestion,
  ShieldCheck, Coins, LayoutTemplate, Save, Filter, Settings, Paperclip, File as FileIcon,
  Image as ImageIcon, Code, SquareCode, Quote, PenLine, Eye, Cpu, LoaderCircle,
  MessageSquarePlus, SendHorizontal, User, Zap, ListEnd, FilePen, FilePenLine, FileText,
  Terminal, Search, FolderSearch, FolderOpen, Globe, ListChecks, UserPlus, MessageSquare,
  CornerDownLeft, Power, Wrench, Bug, Shuffle, SearchCheck,
} from 'lucide-react';

const LUCIDE = {
  Circle, Activity, Check, X, Pause, WifiOff, History, TriangleAlert, OctagonAlert,
  RotateCw, Bot, Plus, CornerLeftUp, ArrowLeft, Folder, Bell, Unlink, Sun, Moon,
  Clock, AlignLeft, Users, ChevronDown, ChevronRight, Braces, MessageCircleQuestion,
  ShieldCheck, Coins, LayoutTemplate, Save, Filter, Settings, Paperclip, File: FileIcon,
  Image: ImageIcon, Code, SquareCode, Quote, PenLine, Eye, Cpu, LoaderCircle,
  MessageSquarePlus, SendHorizontal, User, Zap, ListEnd, FilePen, FilePenLine, FileText,
  Terminal, Search, FolderSearch, FolderOpen, Globe, ListChecks, UserPlus, MessageSquare,
  CornerDownLeft, Power, Wrench, Bug, Shuffle, SearchCheck,
};

/** Semantic → Lucide name. Change an icon here, never at a call site. */
export const ICONS = {
  idle: 'Circle', running: 'Activity', done: 'Check', error: 'X', interrupted: 'Pause',
  disconnected: 'WifiOff', readonly: 'History', warning: 'TriangleAlert', critical: 'OctagonAlert',
  caution: 'TriangleAlert', resume: 'RotateCw', orchestration: 'Bot', add: 'Plus', parent: 'CornerLeftUp',
  back: 'ArrowLeft', folder: 'Folder', needsYou: 'Bell', unlink: 'Unlink', sun: 'Sun', moon: 'Moon',
  timeline: 'Clock', transcript: 'AlignLeft', crew: 'Users', chevronDown: 'ChevronDown', chevronRight: 'ChevronRight',
  raw: 'Braces', question: 'MessageCircleQuestion', approval: 'ShieldCheck', check: 'Check', close: 'X',
  budget: 'Coins', template: 'LayoutTemplate', draft: 'Save', filter: 'Filter', settings: 'Settings',
  attach: 'Paperclip', file: 'File', image: 'Image', code: 'Code', codeBlock: 'SquareCode', quote: 'Quote',
  write: 'PenLine', preview: 'Eye', model: 'Cpu', loading: 'LoaderCircle',
  steer: 'MessageSquarePlus', send: 'SendHorizontal', you: 'User', now: 'Zap', nextTurn: 'ListEnd',
  // tool names (Claude Code + Foreman MCP)
  Write: 'FilePen', Edit: 'FilePenLine', MultiEdit: 'FilePenLine', Read: 'FileText', Bash: 'Terminal',
  Grep: 'Search', Glob: 'FolderSearch', LS: 'FolderOpen', WebFetch: 'Globe', WebSearch: 'Globe',
  Task: 'ListChecks', TodoWrite: 'ListChecks', spawn_worker: 'UserPlus', message_worker: 'MessageSquare',
  ask_human: 'MessageCircleQuestion', result: 'CornerDownLeft', init: 'Power', tool: 'Wrench',
  // mission template chips
  Bug: 'Bug', Shuffle: 'Shuffle', SearchCheck: 'SearchCheck',
};

/** Lucide icon by semantic name; unknown names fall back to the wrench. */
export function Icon({ name, size = 16, strokeWidth = 1.75, color, label, style }) {
  const lucideName = ICONS[name] || name;
  const Cmp = LUCIDE[lucideName] || LUCIDE[ICONS.tool];
  return (
    <Cmp width={size} height={size} strokeWidth={strokeWidth}
      color={color || 'currentColor'}
      aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined}
      style={{ flex: '0 0 auto', display: 'block', ...style }} />
  );
}
