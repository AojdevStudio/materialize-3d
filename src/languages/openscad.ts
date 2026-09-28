/**
 * OpenSCAD language definition for Monaco's Monarch tokenizer.
 *
 * Provides keyword highlighting, comment support, string literals,
 * built-in variables ($fn, $fa, $fs), and operator highlighting.
 */
import type * as monaco from 'monaco-editor'

export const OPENSCAD_LANGUAGE_ID = 'openscad'

export const openscadLanguageConfig: monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
}

export const openscadMonarchTokens: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.scad',

  keywords: [
    'module', 'function', 'if', 'else', 'for', 'let', 'each',
    'include', 'use', 'intersection', 'union', 'difference',
    'translate', 'rotate', 'scale', 'cube', 'sphere', 'cylinder',
    'linear_extrude', 'rotate_extrude', 'polygon', 'circle', 'square',
    'hull', 'minkowski', 'render', 'color', 'mirror', 'multmatrix',
    'projection', 'import', 'surface', 'resize', 'offset',
    'children', 'echo', 'assert', 'text', 'polyhedron',
  ],

  builtinConstants: [
    'true', 'false', 'undef', 'PI',
  ],

  builtinVariables: [
    '$fn', '$fa', '$fs', '$t', '$vpr', '$vpt', '$vpd', '$vpf',
    '$children', '$preview',
  ],

  operators: [
    '=', '>', '<', '!', '~', '?', ':',
    '==', '<=', '>=', '!=', '&&', '||',
    '+', '-', '*', '/', '%', '^',
  ],

  symbols: /[=><!~?:&|+\-*/^%]+/,

  tokenizer: {
    root: [
      // Built-in variables ($fn, $fa, etc.)
      [/\$[a-zA-Z_]\w*/, 'variable.predefined'],

      // Identifiers and keywords
      [/[a-z_]\w*/, {
        cases: {
          '@keywords': 'keyword',
          '@builtinConstants': 'constant.language',
          '@default': 'identifier',
        },
      }],

      // Whitespace
      { include: '@whitespace' },

      // Delimiters and operators
      [/[{}()[\]]/, '@brackets'],
      [/@symbols/, {
        cases: {
          '@operators': 'operator',
          '@default': '',
        },
      }],

      // Numbers
      [/\d*\.\d+([eE][-+]?\d+)?/, 'number.float'],
      [/\d+/, 'number'],

      // Strings
      [/"([^"\\]|\\.)*$/, 'string.invalid'], // unterminated string
      [/"/, { token: 'string.quote', bracket: '@open', next: '@string' }],

      // Semicolons
      [/[;,.]/, 'delimiter'],
    ],

    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
    ],

    whitespace: [
      [/[ \t\r\n]+/, 'white'],
      [/\/\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment'],
    ],

    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
}

/**
 * Register the OpenSCAD language with Monaco.
 * Safe to call multiple times — checks if already registered.
 */
export function registerOpenScadLanguage(monacoInstance: typeof monaco) {
  const languages = monacoInstance.languages.getLanguages()
  if (languages.some((lang) => lang.id === OPENSCAD_LANGUAGE_ID)) {
    return // Already registered
  }

  monacoInstance.languages.register({
    id: OPENSCAD_LANGUAGE_ID,
    extensions: ['.scad'],
    aliases: ['OpenSCAD', 'openscad'],
  })

  monacoInstance.languages.setMonarchTokensProvider(
    OPENSCAD_LANGUAGE_ID,
    openscadMonarchTokens,
  )

  monacoInstance.languages.setLanguageConfiguration(
    OPENSCAD_LANGUAGE_ID,
    openscadLanguageConfig,
  )
}
