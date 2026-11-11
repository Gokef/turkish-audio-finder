'use strict';

// Turkish language definition.
// To add another language, copy this file (e.g. de.js), adapt the patterns
// and register it in ./index.js. Everything else is language-agnostic.

// Separator class used between words in release names: space . _ - + / [ ] ( )
const S = '[\\s._\\-+/\\[\\]()]*';
// Word boundary that also treats "." "_" "-" "[" etc. as boundaries.
const B = '(?<![a-z0-9])';
const E = '(?![a-z0-9])';

// Words that mean "Turkish" in release names.
const TR_WORD = '(?:tr|tur|turk|turkish|t[uü]rk[cç]e|turkce)';
// Words that mean "English".
const EN_WORD = '(?:en|eng|english|ing|ingilizce)';

module.exports = {
  code: 'tr',
  name: 'Turkish',
  flag: '🇹🇷',
  // Torrentio "language" option that sorts this language's streams first.
  torrentioLanguage: 'turkish',

  catalogNames: {
    movie: '🇹🇷 Turkish Dual-Audio Movies',
    series: '🇹🇷 Turkish Dual-Audio Series',
  },

  // Explicit statements that the release carries Turkish AUDIO. (tier 3)
  audioPatterns: [
    new RegExp(`${B}${TR_WORD}${S}dubla[jy]`, 'i'),             // TR Dublaj, Türkçe Dublaj
    new RegExp(`${B}dublaj(?:l[iı])?${E}`, 'i'),                  // Dublaj, Dublajlı
    new RegExp(`${B}turkish${S}(?:dub|dubbed|dubbing|audio)${E}`, 'i'),
    new RegExp(`${B}(?:tr|tur)${S}(?:audio|ses|dub|dubbed)${E}`, 'i'),
    new RegExp(`${B}(?:dual|multi)${S}(?:audio${S})?(?:\\d${S})?${TR_WORD}${E}`, 'i'), // DUAL AUDIO TUR, MULTI TR
    new RegExp(`${B}${TR_WORD}${S}(?:dual|multi)${E}`, 'i'),      // TR DUAL
    new RegExp(`${B}t[uü]rk[cç]e${S}(?:ses|seslendirme)${E}`, 'i'),
  ],

  // "English + Turkish" style pairs: EN-TR, TR-EN, ENG+TUR, English + Turkish Audio. (tier 3, dual)
  pairPatterns: [
    new RegExp(`${B}${EN_WORD}${S}[-+&/,|]${S}${TR_WORD}${E}`, 'i'),
    new RegExp(`${B}${TR_WORD}${S}[-+&/,|]${S}${EN_WORD}${E}`, 'i'),
    new RegExp(`${B}english${S}(?:and|ve)${S}turkish${E}`, 'i'),
  ],

  // Release groups that (to our knowledge) publish TR+EN dual-audio releases. (tier 2, dual)
  // Extend with env TR_GROUPS=GROUP1,GROUP2
  groups: ['TURG'],

  // A bare mention of the language (ambiguous: could be subs, a title word, ...). (tier 1)
  tokenPattern: new RegExp(`${B}(?:tr|tur|turkish|t[uü]rk[cç]e|turkce)${E}`, 'i'),

  // Code used inside explicit language lists: "Eng.Fre.Ger.Ita.Tur.Chi"
  listCode: 'tur',

  // Subtitle phrases. Any Turkish mention inside these is ignored.
  subtitlePatterns: [
    new RegExp(`${B}${TR_WORD}${S}(?:sub|subs|subbed|subtitle|subtitles|altyaz[iı](?:l[iı])?|srt)${E}`, 'i'),
    new RegExp(`${B}(?:sub|subs|subtitles?|subbed|altyaz[iı](?:l[iı])?)${S}[:=]?${S}(?:[a-z]{2,3}${S}){0,12}${TR_WORD}${E}`, 'i'),
    new RegExp(`${B}altyaz[iı](?:l[iı])?${E}`, 'i'),
    new RegExp(`${B}(?:hard|soft)?sub(?:bed)?${S}${TR_WORD}${E}`, 'i'),
  ],
};
