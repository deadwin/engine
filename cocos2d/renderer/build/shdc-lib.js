'use strict';

const tokenizer = require('glsl-tokenizer/string');
const mappings = require('../mappings');

let includeRE = /#include +<([\w-.]+)>/gm;
let defineRE = /#define\s+(\w+)\(([\w,\s]+)\)\s+(.*##.*)\n/g;
let whitespaces = /\s+/g;
let ident = /^[_a-zA-Z]\w*$/;
let extensionRE = /(?:GL_)?(\w+)/;
let comparators = /^[<=>]+$/;
let ifprocessor = /#(el)?if/;
let rangePragma = /range\(([\d.,\s]+)\)\s(\w+)/;
let defaultPragma = /default\(([\d.,]+)\)/;
let namePragma = /name\(([^)]+)\)/;
let precision = /(low|medium|high)p/;

// (HACKY) extract all builtin uniforms to the ignore list
let uniformIgnoreList = {viewProj: true, model: true};
// let uniformIgnoreList = (function() {
//   let path = 'cocos/renderer/renderers/forward-renderer.js';
//   let renderer = fs.readFileSync(path, { encoding: 'utf8' });
//   let re = /set(Uniform|Texture)\([`'"](\w+)[`'"]/g, cap = re.exec(renderer);
//   let result = [];
//   while (cap) { result.push(cap[2]); cap = re.exec(renderer); }
//   return result;
// })();

function convertType(t) { let tp = mappings.typeParams[t.toUpperCase()]; return tp === undefined ? t : tp; }

function unwindIncludes(str, chunks) {
  function replace(match, include) {
    let replace = chunks[include];
    if (replace === undefined) {
      console.error(`can not resolve #include <${include}>`);
    }
    return unwindIncludes(replace, chunks);
  }
  return str.replace(includeRE, replace);
}

function glslStripComment(code) {
  let tokens = tokenizer(code);

  let result = '';
  for (let i = 0; i < tokens.length; ++i) {
    let t = tokens[i];
    if (t.type != 'block-comment' && t.type != 'line-comment' && t.type != 'eof') {
      result += t.data;
    }
  }

  return result;
}

function extractDefines(tokens, defines, cache) {
  let curDefs = [], save = (line) => {
    cache[line] = curDefs.reduce((acc, val) => acc.concat(val), []);
    cache.lines.push(line);
  };
  for (let i = 0; i < tokens.length; ++i) {
    let t = tokens[i], str = t.data, id, df;
    if (t.type !== 'preprocessor') continue;
    str = str.split(whitespaces);
    if (str[0] === '#endif') {
        curDefs.pop(); save(t.line); continue;
    } else if (str[0] === '#else') {
      curDefs[curDefs.length - 1].length = 0; save(t.line); continue;
    } else if (str[0] === '#pragma') {
      if (str[1] === 'for') { curDefs.push(0); save(t.line); }
      else if (str[1] === 'endFor') { curDefs.pop(); save(t.line); }
      else if (str[1][0] === '#') cache[t.line] = str.splice(1);
      else {
        let mc = rangePragma.exec(t.data);
        if (!mc) continue;
        let def = defines.find(d => d.name === mc[2]);
        if (!def) defines.push(def = { name: mc[2] });
        def.type = 'number';
        def.range = JSON.parse(`[${mc[1]}]`);
      }
      continue;
    } else if (!ifprocessor.test(str[0])) continue;
    if (str[0] === '#elif') { curDefs.pop(); save(t.line); }
    let defs = [];
    str.splice(1).some(s => {
      id = s.match(ident);
      if (id) { // is identifier
        defs.push(id[0]);
        df = defines.find(d => d.name === id[0]);
        if (df) return; // first encounter
        defines.push(df = { name: id[0], type: 'boolean' });
      } else if (comparators.test(s)) df.type = 'number';
      else if (s === '||') return true;
    });
    curDefs.push(defs); save(t.line);
  }
  return defines;
}

/* here the `define dependency` for some param is interpreted as
 * the existance of some define ids directly desides the existance of that param.
 * so basically therer is no logical expression support
 * (all will be treated as '&&' operator)
 * for wrapping unifom, attribute and extension declarations.
 * try to write them in straightforward ways like:
 *     #ifdef USE_COLOR
 *         attribute vec4 a_color;
 *     #endif
 * or nested when needed:
 *     #if USE_BILLBOARD && BILLBOARD_STRETCHED
 *         uniform vec3 stretch_color;
 *         #ifdef USE_NORMAL_TEXTURE
 *             uniform sampler2D tex_normal;
 *         #endif
 *     #endif // no else branch
 */
function extractParams(tokens, cache, uniforms, attributes, extensions) {
  let getDefs = line => {
    let idx = cache.lines.findIndex(i => i > line);
    return cache[cache.lines[idx - 1]] || [];
  };
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i], tp = t.type, str = t.data, dest;
    if (tp === 'keyword' && str === 'uniform') dest = uniforms;
    else if (tp === 'keyword' && str === 'attribute') dest = attributes;
    else if (tp === 'preprocessor' && str.startsWith('#extension')) dest = extensions;
    else continue;
    let defines = getDefs(t.line), param = {};
    if (defines.findIndex(i => !i) >= 0) continue; // inside pragmas
    if (dest === uniforms && uniformIgnoreList[tokens[i+4].data]) continue;
    if (dest === extensions) {
      if (defines.length > 1) console.warn('extensions must be under controll of no more than 1 define');
      param.name = extensionRE.exec(str.split(whitespaces)[1])[1];
      param.define = defines[0];
      dest.push(param);
      continue;
    } else { // uniforms and attributes
      let offset = precision.exec(tokens[i+2].data) ? 4 : 2;
      param.name = tokens[i+offset+2].data;
      param.type = convertType(tokens[i+offset].data);
      let tags = cache[t.line - 1];
      if (tags && tags[0][0] === '#') { // tags
        let mc = defaultPragma.exec(tags.join(''));
        if (mc && mc[1].length > 0) {
          mc = JSON.parse(`[${mc[1]}]`);
          if (mc.length === 1) param.value = mc[0];
          else param.value = mc;
        }
        mc = namePragma.exec(tags.join(' '));
        if (mc) param.displayName = mc[1];
        for (let j = 0; j < tags.length; j++) {
          let tag = tags[j];
          if (tag === '#color') param.type = convertType(param.type);
          else if (tag === '#property') param.property = true;
        }
      }
    }
    param.defines = defines;
    dest.push(param);
  }
}

let expandStructMacro = (function() {
  function matchParenthesisPair(string, startIdx) {
    let parHead = startIdx;
    let parTail = parHead;
    let depth = 0;
    for (let i = startIdx; i < string.length; i++)
      if (string[i] === '(') { parHead = i; depth = 1; break; }
    if (depth === 0) return parHead;
    for (let i = parHead + 1; i < string.length; i++) {
      if (string[i] === '(') depth++;
      if (string[i] === ')') depth--;
      if (depth === 0) { parTail = i; break; }
    }
    if (depth !== 0) return parHead;
    return parTail;
  }
  function generateHypenRE(hyphen, macroParam) {
    return '(' + [hyphen + macroParam + hyphen, hyphen + macroParam, macroParam + hyphen].join('|') + ')';
  }
  function generateParamRE(param) {
    return '\\b' + param + '\\b';
  }
  return function (code) {
    code = code.replace(/\\\n/g, '');
    let defineCapture = defineRE.exec(code);
    //defineCapture[1] - the macro name
    //defineCapture[2] - the macro parameters
    //defineCapture[3] - the macro body
    while (defineCapture != null) {
      let macroRE = new RegExp('\\n.*' + defineCapture[1] + '\\s*\\(', 'g');
      let macroCapture = macroRE.exec(code);
      while (macroCapture != null) {
        let macroIndex = macroCapture[0].lastIndexOf(defineCapture[1]);
        //the whole macro string,include name and arguments
        let macroStr = code.slice(macroCapture.index + macroIndex, matchParenthesisPair(code, macroCapture.index + macroCapture[0].length - 1) + 1);
        //the macro arguments list
        let macroArguLine = macroStr.slice(macroCapture[0].length - macroIndex, -1);
        //the string before macro's name in the matched line
        let prefix = macroCapture[0].slice(0, macroIndex);
        let containDefine = prefix.indexOf('#define') !== -1;
        let containParenthesis = prefix.indexOf('(') !== -1;
        let macroParams = defineCapture[2].split(',');
        //erase the white space in the macro's parameters
        for (let i = 0; i < macroParams.length; i++) {
          macroParams[i] = macroParams[i].replace(/\s/g, '');
        }
        let macroArgus = macroArguLine.split(',');
        for (let i = 0; i < macroArgus.length; i++) {
          macroArgus[i] = macroArgus[i].replace(/\s/g, '');
        }
        //if the matched macro is defined in another macro, then just replace the parameters with the arguments
        if (containDefine && containParenthesis) {
          code = code.replace(new RegExp(defineCapture[1] + '\\(' + macroArguLine + '\\)', 'g'), (matched, offset) => {
            //if the matched string is the marco we just found,the replace it
            if (macroCapture.index + prefix.length == offset) {
              let ret = defineCapture[3];
              for (let i = 0; i < macroParams.length; i++) {
                ret = ret.replace(new RegExp(generateParamRE(macroParams[i]), 'g'), macroArgus[i]);
              }
              return ret;
            }
            return matched;
          });
          //move the next match index to the beginning of the line,in case of the same macro on the same line.
          macroRE.lastIndex -= macroCapture[0].length;
        }
        //if the matched macro is defined in the executable code block,we should consider the hypen sign('##')
        if (!containDefine) {
          let repStr = defineCapture[3];
          for (let i = 0; i < macroParams.length; i++) {
            let hypenRE = new RegExp(generateHypenRE('##', macroParams[i]), 'g');
            if (hypenRE.test(repStr)) {
              //replace the hypen sign
              repStr = repStr.replace(hypenRE, macroArgus[i]);
            } else {
              repStr = repStr.replace(new RegExp(generateParamRE(macroParams[i]), 'g'), macroArgus[i]);
            }
          }
          code = code.replace(macroStr, repStr);
          //move the next match index to the beginning of the line,in case of the same macro on the same line.
          macroRE.lastIndex -= macroCapture[0].length;
        }
        macroCapture = macroRE.exec(code);
      }
      defineCapture = defineRE.exec(code);
    }
    return code;
  };
})();

let assemble = (function() {
  let entryRE = /([\w-]+)(?::(\w+))?/;
  let integrity = /void\s+main\s*\(\s*\)/g;
  let wrapperFactory = (vert, fn) => `\nvoid main() { ${vert ? 'gl_Position' : 'gl_FragColor'} = ${fn}(); }\n`;
  return function(name, cache, vert) {
    let entryCap = entryRE.exec(name), content = cache[entryCap[1]];
    if (!content) { console.error(`${entryCap[1]} not found, please check again.`); return ''; }
    if (!entryCap[2]) {
      if (!integrity.test(content)) console.error(`no main function found in ${name}!`);
      return cache[name];
    }
    return content + wrapperFactory(vert, entryCap[2]);
  };
})();

let build = function(vert, frag, cache) {
  let defines = [], defCache = { lines: [] }, tokens;
  let uniforms = [], attributes = [], extensions = [];

  vert = glslStripComment(vert);
  vert = unwindIncludes(vert, cache);
  vert = expandStructMacro(vert);
  tokens = tokenizer(vert);
  extractDefines(tokens, defines, defCache);
  extractParams(tokens, defCache, uniforms, attributes, extensions);

  defCache = { lines: [] };
  frag = glslStripComment(frag);
  frag = unwindIncludes(frag, cache);
  frag = expandStructMacro(frag);
  tokens = tokenizer(frag);
  extractDefines(tokens, defines, defCache);
  extractParams(tokens, defCache, uniforms, attributes, extensions);

  return { vert, frag, defines, uniforms, attributes, extensions };
};

let assembleAndBuild = function(vertName, fragName, cache) {
  let vert = assemble(vertName, cache, true);
  let frag = assemble(fragName, cache);
  return build(vert, frag, cache);
};

// ==================
// exports
// ==================

module.exports = {
  glslStripComment,
  assemble,
  build,
  assembleAndBuild
};
