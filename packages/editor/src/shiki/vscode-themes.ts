import type { EditorTheme } from '../theme'
import { editorThemeFromShikiTheme, type ShikiThemeLike } from './theme-extract'

export type VscodeThemeRegistration = ShikiThemeLike & {
  readonly name?: string
  readonly displayName?: string
  readonly type?: 'dark' | 'light'
}

export type VscodeThemeDefinition = {
  readonly id: string
  readonly label: string
  readonly shikiName: string
  readonly type: 'dark' | 'light'
}

type VscodeThemeModule = {
  readonly default: VscodeThemeRegistration
}

type VscodeThemeLoader = () => Promise<VscodeThemeModule>

export const VSCODE_THEMES = [
  { id: 'andromeeda', label: 'Andromeeda', shikiName: 'andromeeda', type: 'dark' },
  { id: 'aurora-x', label: 'Aurora X', shikiName: 'aurora-x', type: 'dark' },
  { id: 'ayu-dark', label: 'Ayu Dark', shikiName: 'ayu-dark', type: 'dark' },
  { id: 'ayu-light', label: 'Ayu Light', shikiName: 'ayu-light', type: 'light' },
  { id: 'ayu-mirage', label: 'Ayu Mirage', shikiName: 'ayu-mirage', type: 'dark' },
  {
    id: 'catppuccin-frappe',
    label: 'Catppuccin Frappé',
    shikiName: 'catppuccin-frappe',
    type: 'dark',
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    shikiName: 'catppuccin-latte',
    type: 'light',
  },
  {
    id: 'catppuccin-macchiato',
    label: 'Catppuccin Macchiato',
    shikiName: 'catppuccin-macchiato',
    type: 'dark',
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    shikiName: 'catppuccin-mocha',
    type: 'dark',
  },
  { id: 'dark-plus', label: 'Dark Plus', shikiName: 'dark-plus', type: 'dark' },
  { id: 'dracula', label: 'Dracula Theme', shikiName: 'dracula', type: 'dark' },
  { id: 'dracula-soft', label: 'Dracula Theme Soft', shikiName: 'dracula-soft', type: 'dark' },
  { id: 'everforest-dark', label: 'Everforest Dark', shikiName: 'everforest-dark', type: 'dark' },
  {
    id: 'everforest-light',
    label: 'Everforest Light',
    shikiName: 'everforest-light',
    type: 'light',
  },
  { id: 'github-dark', label: 'GitHub Dark', shikiName: 'github-dark', type: 'dark' },
  {
    id: 'github-dark-default',
    label: 'GitHub Dark Default',
    shikiName: 'github-dark-default',
    type: 'dark',
  },
  {
    id: 'github-dark-dimmed',
    label: 'GitHub Dark Dimmed',
    shikiName: 'github-dark-dimmed',
    type: 'dark',
  },
  {
    id: 'github-dark-high-contrast',
    label: 'GitHub Dark High Contrast',
    shikiName: 'github-dark-high-contrast',
    type: 'dark',
  },
  { id: 'github-light', label: 'GitHub Light', shikiName: 'github-light', type: 'light' },
  {
    id: 'github-light-default',
    label: 'GitHub Light Default',
    shikiName: 'github-light-default',
    type: 'light',
  },
  {
    id: 'github-light-high-contrast',
    label: 'GitHub Light High Contrast',
    shikiName: 'github-light-high-contrast',
    type: 'light',
  },
  {
    id: 'gruvbox-dark-hard',
    label: 'Gruvbox Dark Hard',
    shikiName: 'gruvbox-dark-hard',
    type: 'dark',
  },
  {
    id: 'gruvbox-dark-medium',
    label: 'Gruvbox Dark Medium',
    shikiName: 'gruvbox-dark-medium',
    type: 'dark',
  },
  {
    id: 'gruvbox-dark-soft',
    label: 'Gruvbox Dark Soft',
    shikiName: 'gruvbox-dark-soft',
    type: 'dark',
  },
  {
    id: 'gruvbox-light-hard',
    label: 'Gruvbox Light Hard',
    shikiName: 'gruvbox-light-hard',
    type: 'light',
  },
  {
    id: 'gruvbox-light-medium',
    label: 'Gruvbox Light Medium',
    shikiName: 'gruvbox-light-medium',
    type: 'light',
  },
  {
    id: 'gruvbox-light-soft',
    label: 'Gruvbox Light Soft',
    shikiName: 'gruvbox-light-soft',
    type: 'light',
  },
  { id: 'horizon', label: 'Horizon', shikiName: 'horizon', type: 'dark' },
  { id: 'horizon-bright', label: 'Horizon Bright', shikiName: 'horizon-bright', type: 'light' },
  { id: 'houston', label: 'Houston', shikiName: 'houston', type: 'dark' },
  { id: 'kanagawa-dragon', label: 'Kanagawa Dragon', shikiName: 'kanagawa-dragon', type: 'dark' },
  { id: 'kanagawa-lotus', label: 'Kanagawa Lotus', shikiName: 'kanagawa-lotus', type: 'light' },
  { id: 'kanagawa-wave', label: 'Kanagawa Wave', shikiName: 'kanagawa-wave', type: 'dark' },
  { id: 'laserwave', label: 'LaserWave', shikiName: 'laserwave', type: 'dark' },
  { id: 'light-plus', label: 'Light Plus', shikiName: 'light-plus', type: 'light' },
  { id: 'material-theme', label: 'Material Theme', shikiName: 'material-theme', type: 'dark' },
  {
    id: 'material-theme-darker',
    label: 'Material Theme Darker',
    shikiName: 'material-theme-darker',
    type: 'dark',
  },
  {
    id: 'material-theme-lighter',
    label: 'Material Theme Lighter',
    shikiName: 'material-theme-lighter',
    type: 'light',
  },
  {
    id: 'material-theme-ocean',
    label: 'Material Theme Ocean',
    shikiName: 'material-theme-ocean',
    type: 'dark',
  },
  {
    id: 'material-theme-palenight',
    label: 'Material Theme Palenight',
    shikiName: 'material-theme-palenight',
    type: 'dark',
  },
  { id: 'min-dark', label: 'Min Dark', shikiName: 'min-dark', type: 'dark' },
  { id: 'min-light', label: 'Min Light', shikiName: 'min-light', type: 'light' },
  { id: 'monokai', label: 'Monokai', shikiName: 'monokai', type: 'dark' },
  { id: 'night-owl', label: 'Night Owl', shikiName: 'night-owl', type: 'dark' },
  { id: 'night-owl-light', label: 'Night Owl Light', shikiName: 'night-owl-light', type: 'light' },
  { id: 'nord', label: 'Nord', shikiName: 'nord', type: 'dark' },
  { id: 'one-dark-pro', label: 'One Dark Pro', shikiName: 'one-dark-pro', type: 'dark' },
  { id: 'one-light', label: 'One Light', shikiName: 'one-light', type: 'light' },
  { id: 'plastic', label: 'Plastic', shikiName: 'plastic', type: 'dark' },
  { id: 'poimandres', label: 'Poimandres', shikiName: 'poimandres', type: 'dark' },
  { id: 'red', label: 'Red', shikiName: 'red', type: 'dark' },
  { id: 'rose-pine', label: 'Rosé Pine', shikiName: 'rose-pine', type: 'dark' },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', shikiName: 'rose-pine-dawn', type: 'light' },
  { id: 'rose-pine-moon', label: 'Rosé Pine Moon', shikiName: 'rose-pine-moon', type: 'dark' },
  { id: 'slack-dark', label: 'Slack Dark', shikiName: 'slack-dark', type: 'dark' },
  { id: 'slack-ochin', label: 'Slack Ochin', shikiName: 'slack-ochin', type: 'light' },
  { id: 'snazzy-light', label: 'Snazzy Light', shikiName: 'snazzy-light', type: 'light' },
  { id: 'solarized-dark', label: 'Solarized Dark', shikiName: 'solarized-dark', type: 'dark' },
  { id: 'solarized-light', label: 'Solarized Light', shikiName: 'solarized-light', type: 'light' },
  { id: 'synthwave-84', label: "Synthwave '84", shikiName: 'synthwave-84', type: 'dark' },
  { id: 'tokyo-night', label: 'Tokyo Night', shikiName: 'tokyo-night', type: 'dark' },
  { id: 'vesper', label: 'Vesper', shikiName: 'vesper', type: 'dark' },
  { id: 'vitesse-black', label: 'Vitesse Black', shikiName: 'vitesse-black', type: 'dark' },
  { id: 'vitesse-dark', label: 'Vitesse Dark', shikiName: 'vitesse-dark', type: 'dark' },
  { id: 'vitesse-light', label: 'Vitesse Light', shikiName: 'vitesse-light', type: 'light' },
] satisfies readonly VscodeThemeDefinition[]

const VSCODE_THEME_LOADERS: Readonly<Record<string, VscodeThemeLoader>> = {
  andromeeda: () => import('@shikijs/themes/andromeeda'),
  'aurora-x': () => import('@shikijs/themes/aurora-x'),
  'ayu-dark': () => import('@shikijs/themes/ayu-dark'),
  'ayu-light': () => import('@shikijs/themes/ayu-light'),
  'ayu-mirage': () => import('@shikijs/themes/ayu-mirage'),
  'catppuccin-frappe': () => import('@shikijs/themes/catppuccin-frappe'),
  'catppuccin-latte': () => import('@shikijs/themes/catppuccin-latte'),
  'catppuccin-macchiato': () => import('@shikijs/themes/catppuccin-macchiato'),
  'catppuccin-mocha': () => import('@shikijs/themes/catppuccin-mocha'),
  'dark-plus': () => import('@shikijs/themes/dark-plus'),
  dracula: () => import('@shikijs/themes/dracula'),
  'dracula-soft': () => import('@shikijs/themes/dracula-soft'),
  'everforest-dark': () => import('@shikijs/themes/everforest-dark'),
  'everforest-light': () => import('@shikijs/themes/everforest-light'),
  'github-dark': () => import('@shikijs/themes/github-dark'),
  'github-dark-default': () => import('@shikijs/themes/github-dark-default'),
  'github-dark-dimmed': () => import('@shikijs/themes/github-dark-dimmed'),
  'github-dark-high-contrast': () => import('@shikijs/themes/github-dark-high-contrast'),
  'github-light': () => import('@shikijs/themes/github-light'),
  'github-light-default': () => import('@shikijs/themes/github-light-default'),
  'github-light-high-contrast': () => import('@shikijs/themes/github-light-high-contrast'),
  'gruvbox-dark-hard': () => import('@shikijs/themes/gruvbox-dark-hard'),
  'gruvbox-dark-medium': () => import('@shikijs/themes/gruvbox-dark-medium'),
  'gruvbox-dark-soft': () => import('@shikijs/themes/gruvbox-dark-soft'),
  'gruvbox-light-hard': () => import('@shikijs/themes/gruvbox-light-hard'),
  'gruvbox-light-medium': () => import('@shikijs/themes/gruvbox-light-medium'),
  'gruvbox-light-soft': () => import('@shikijs/themes/gruvbox-light-soft'),
  horizon: () => import('@shikijs/themes/horizon'),
  'horizon-bright': () => import('@shikijs/themes/horizon-bright'),
  houston: () => import('@shikijs/themes/houston'),
  'kanagawa-dragon': () => import('@shikijs/themes/kanagawa-dragon'),
  'kanagawa-lotus': () => import('@shikijs/themes/kanagawa-lotus'),
  'kanagawa-wave': () => import('@shikijs/themes/kanagawa-wave'),
  laserwave: () => import('@shikijs/themes/laserwave'),
  'light-plus': () => import('@shikijs/themes/light-plus'),
  'material-theme': () => import('@shikijs/themes/material-theme'),
  'material-theme-darker': () => import('@shikijs/themes/material-theme-darker'),
  'material-theme-lighter': () => import('@shikijs/themes/material-theme-lighter'),
  'material-theme-ocean': () => import('@shikijs/themes/material-theme-ocean'),
  'material-theme-palenight': () => import('@shikijs/themes/material-theme-palenight'),
  'min-dark': () => import('@shikijs/themes/min-dark'),
  'min-light': () => import('@shikijs/themes/min-light'),
  monokai: () => import('@shikijs/themes/monokai'),
  'night-owl': () => import('@shikijs/themes/night-owl'),
  'night-owl-light': () => import('@shikijs/themes/night-owl-light'),
  nord: () => import('@shikijs/themes/nord'),
  'one-dark-pro': () => import('@shikijs/themes/one-dark-pro'),
  'one-light': () => import('@shikijs/themes/one-light'),
  plastic: () => import('@shikijs/themes/plastic'),
  poimandres: () => import('@shikijs/themes/poimandres'),
  red: () => import('@shikijs/themes/red'),
  'rose-pine': () => import('@shikijs/themes/rose-pine'),
  'rose-pine-dawn': () => import('@shikijs/themes/rose-pine-dawn'),
  'rose-pine-moon': () => import('@shikijs/themes/rose-pine-moon'),
  'slack-dark': () => import('@shikijs/themes/slack-dark'),
  'slack-ochin': () => import('@shikijs/themes/slack-ochin'),
  'snazzy-light': () => import('@shikijs/themes/snazzy-light'),
  'solarized-dark': () => import('@shikijs/themes/solarized-dark'),
  'solarized-light': () => import('@shikijs/themes/solarized-light'),
  'synthwave-84': () => import('@shikijs/themes/synthwave-84'),
  'tokyo-night': () => import('@shikijs/themes/tokyo-night'),
  vesper: () => import('@shikijs/themes/vesper'),
  'vitesse-black': () => import('@shikijs/themes/vitesse-black'),
  'vitesse-dark': () => import('@shikijs/themes/vitesse-dark'),
  'vitesse-light': () => import('@shikijs/themes/vitesse-light'),
}

export function loadVscodeThemeRegistration(
  theme: VscodeThemeDefinition | string,
): Promise<VscodeThemeRegistration> {
  const shikiName = typeof theme === 'string' ? theme : theme.shikiName
  const loader = VSCODE_THEME_LOADERS[shikiName]
  if (!loader) throw new Error(`Unknown VSCode theme: ${shikiName}`)

  return loader().then((module) => module.default)
}

export function editorThemeFromVscodeTheme(registration: VscodeThemeRegistration): EditorTheme {
  return editorThemeFromShikiTheme({
    bg: registration.bg ?? registration.colors?.['editor.background'],
    fg: registration.fg ?? registration.colors?.['editor.foreground'],
    colors: registration.colors,
    tokenColors: registration.tokenColors ?? registration.settings,
  })
}
