'use strict';

const registry = {
  tr: require('./tr'),
};

const LANGUAGE_CODES = ['eng', 'fre', 'fra', 'ger', 'deu', 'ita', 'spa', 'por', 'rus', 'ukr', 'pol', 'cze', 'ces',
  'hun', 'rum', 'ron', 'bul', 'hrv', 'srp', 'slv', 'slo', 'gre', 'ell', 'tur', 'ara', 'heb', 'hin', 'tam', 'tel',
  'tha', 'vie', 'ind', 'may', 'chi', 'zho', 'jpn', 'kor', 'dan', 'swe', 'nor', 'fin', 'dut', 'nld', 'est', 'lav',
  'lit', 'per', 'fas', 'cat', 'baq', 'glg', 'ice', 'isl'];

function getLanguages(codes) {
  return codes.map((c) => {
    const lang = registry[c];
    if (!lang) throw new Error(`Unknown language "${c}". Available: ${Object.keys(registry).join(', ')}`);
    return lang;
  });
}

module.exports = { registry, getLanguages, LANGUAGE_CODES };
