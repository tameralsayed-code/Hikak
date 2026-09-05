/*
 * tajweed-rules-engine.js
 * محرك قواعد الرسم القرآني المشترك — مستقل عن أي مصحف بعينه (البزي أو غيره لاحقًا).
 *
 * ده ملف "منطق خالص" (pure functions): مفيهوش تخزين (localStorage) ولا واجهة (HTML/CSS)
 * ولا بيانات آيات. كل دالة بتاخد الحالة اللي محتاجاها (قواعد الكلمات، إعدادات ميم الجمع)
 * كباراميتر، عشان كل مشروع مصحف يفضل مالك بياناته وتخزينه وواجهته بنفسه، وميحصلش تعارض
 * لو أكتر من مصحف شغالين على نفس الدومين (GitHub Pages مثلاً).
 *
 * الاستخدام في أي مصحف جديد:
 *   <script src="tajweed-rules-engine.js"></script>
 *   ...
 *   TajweedEngine.applyWordRules(flatItems, surahNum, wordRules);
 *   TajweedEngine.applyMeemJamaRule(flatItems, surahNum, { enabled: meemJamaEnabled, exceptions: meemJamaExceptions });
 *
 * "flatItems" = مصفوفة كائنات كل واحد فيها: { text, ayah, wordPos, hidden, displayText, code, ... }
 * وهو نفس الشكل اللي كل مصاحف المشروع (البزي وغيره) بتستخدمه للكلمة الواحدة.
 *
 * عدّل هنا مرة واحدة لما تكتشف حالة تجويدية جديدة أو تصليح باج، وكل المصاحف اللي بتستخدم
 * نسخة محدّثة من الملف ده بتاخد التعديل تلقائيًا.
 */
const TajweedEngine = (function () {

  // --- تطبيع النص العربي: بيشيل كل علامات التشكيل عشان المطابقة تبقى بالحروف بس ---
  function normalizeArabic(text) {
    // بما فيها العلامات الخاصة اللي مصحف المدينة بيستخدمها لرسم التنوين والحركات (بلوك Arabic Extended-A)
    // — وده اللي كان بيسبب "غير مطابق" لما تلصق نص من المصحف فيه تشكيل بالرسم القرآني الخاص.
    return (text || '')
      .replace(/[\u00A0\u200B-\u200F\u202A-\u202E\uFEFF]/g, ' ')
      .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
      .replace(/[\u08D3-\u08FF]/g, '')
      .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
      .replace(/\u06CC/g, '\u064A')
      .replace(/\s+/g, ' ').trim();
  }

  // --- بتحوّل نص مربع الاستثناءات (مفصول بفواصل/أسطر) لمصفوفة مفاتيح: "7" (آية كاملة) أو "7:3" (آية:كلمة) ---
  function parseManualExceptions(raw) {
    return (raw || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  }

  // --- آخر حرف عربي فعلي في النص (متجاهلين أي تشكيل بعده)، مع توحيد صور الهمزة على الألف لألف عادية ---
  function lastArabicLetterOf(text) {
    const m = (text || '').match(/[\u0621-\u064A\u0671-\u06D3](?=[^\u0621-\u064A\u0671-\u06D3]*$)/);
    return m ? m[0].replace(/[\u0622\u0623\u0625\u0671]/, '\u0627') : '';
  }

  // --- منطق مشترك لصلة ميم الجمع (ولأي كلمة تانية بتاخد ضمة/صلة زيها) ---
  // بيفحص الكلمة اللي جاية بعد كلمة اتضاف لها ضمة/صلة، ويرجع:
  //  - هل نتخطى القاعدة هنا؟ (لو الكلمة التالية بتبدأ بساكن صريح أو بألف وصل)
  //  - ولو مش هنتخطى: هل نلطّف شدة أول حرف في الكلمة التالية؟ (لو ناتجة عن إدغام الحرف الساكن
  //    الأصلي في نفس الحرف في أول الكلمة اللي بعدها — إدغام المتماثلين اللي بقى مش متحقق شرطه
  //    بعد ما حوّلنا الحرف الساكن لمتحرك)
  // ملحوظة: التشكيل في بيانات مصحف المدينة/API بييجي بترتيب حرف←حركة←شدة، مش حرف←شدة←حركة.
  function evaluateWaslNeighbor(nextItem, lastLetterOfCurrent) {
    if (!nextItem) return { skip: false };
    const nextText = nextItem.text || '';
    const nextStartsSakin = /^[\u0621-\u064A\u0671\u0672-\u06D3][\u0651]?\u0652/.test(nextText);
    const nextStartsAlif = /^[\u0627\u0671]/.test(nextText);
    if (nextStartsSakin || nextStartsAlif) return { skip: true };
    const nextFirstLetter = nextText.charAt(0).replace(/[\u0622\u0623\u0625\u0671]/, '\u0627');
    const shaddaRelIdx = nextText.slice(1, 3).indexOf('\u0651');
    if (shaddaRelIdx !== -1 && lastLetterOfCurrent && lastLetterOfCurrent === nextFirstLetter) {
      const shaddaAbsIdx = 1 + shaddaRelIdx;
      return { skip: false, softenedNextText: nextText.slice(0, shaddaAbsIdx) + nextText.slice(shaddaAbsIdx + 1) };
    }
    return { skip: false };
  }

  // --- تطبيق قواعد الكلمات اليدوية (بحث واستبدال / تلوين / معنى) على مصفوفة كلمات سورة واحدة ---
  // wordRules: مصفوفة القواعد الخاصة بالمصحف اللي بينادي الدالة (كل مصحف عنده نسخته ومخزّنها بنفسه).
  function applyWordRules(flatItems, surahNum, wordRules) {
    if (!wordRules || !wordRules.length || !flatItems.length) return;
    wordRules.forEach(r => { if (r.scope === 'all' || r.scope === surahNum) r.lastMatchCount = 0; });
    const applicable = wordRules.filter(r => r.scope === 'all' || r.scope === surahNum);
    if (!applicable.length) return;
    const normalRules = applicable.filter(r => !r.revert);
    const revertRules = applicable.filter(r => r.revert);
    normalRules.forEach(rule => {
      rule.lastMatchSurah = surahNum;
      const tokens = rule.searchTokens; const n = tokens.length;
      for (let i = 0; i <= flatItems.length - n; i++) {
        if (flatItems[i].hidden || flatItems[i].displayText) continue;
        let match = true;
        for (let j = 0; j < n; j++) { if (normalizeArabic(flatItems[i + j].text) !== tokens[j]) { match = false; break; } }
        if (match) {
          if (rule.positional) {
            const posOk = String(flatItems[i].ayah) === String(rule.posAyah) && (rule.posWordStart == null || String(flatItems[i].wordPos) === String(rule.posWordStart));
            if (!posOk) continue;
          }
          if (rule.manualExceptions && rule.manualExceptions.length) {
            // استثناءات يدوية كتبها المستخدم في مربع الاستثناءات: "7" يستثني الآية كلها، "7:3" يستثني كلمة بعينها فيها
            const ayahKey = String(flatItems[i].ayah); const posKey = `${ayahKey}:${flatItems[i].wordPos}`;
            if (rule.manualExceptions.includes(ayahKey) || rule.manualExceptions.includes(posKey)) { continue; }
          }
          if (rule.newText) {
            const nextItem = flatItems[i + n];
            const decision = evaluateWaslNeighbor(nextItem, lastArabicLetterOf(flatItems[i].text));
            if (decision.skip) { continue; }
            if (decision.softenedNextText) { nextItem.displayText = decision.softenedNextText; nextItem.code = ''; }
          }
          rule.lastMatchCount = (rule.lastMatchCount || 0) + 1;
          if (rule.newText) {
            flatItems[i].displayText = rule.newText; flatItems[i].code = ''; flatItems[i].displayColor = rule.color || ''; flatItems[i].displayBg = rule.bgColor || ''; flatItems[i].displayStroke = rule.stroke || ''; flatItems[i].meaning = rule.meaning || ''; flatItems[i].markColor = rule.markColor || '';
            for (let j = 1; j < n; j++) flatItems[i + j].hidden = true;
          } else {
            const groupId = n > 1 ? `mg_${Math.random().toString(36).slice(2, 9)}` : '';
            for (let j = 0; j < n; j++) {
              flatItems[i + j].displayColor = rule.color || ''; flatItems[i + j].displayBg = rule.bgColor || ''; flatItems[i + j].displayStroke = rule.stroke || ''; flatItems[i + j].meaning = rule.meaning || ''; flatItems[i + j].markColor = j === 0 ? (rule.markColor || '') : '';
              if (groupId) flatItems[i + j].meaningGroup = groupId;
            }
          }
          i += n - 1;
        }
      }
    });
    // قواعد الاستثناء (revert): بترجع الكلمة لأصلها في موضع محدد بالظبط، حتى لو قاعدة عامة (المصحف كله) غيّرتها.
    // بتتنفذ آخر حاجة عشان تكسب الأولوية دايمًا على أي قاعدة عامة سابقة على نفس الموضع.
    revertRules.forEach(rule => {
      rule.lastMatchSurah = surahNum;
      for (let i = 0; i < flatItems.length; i++) {
        const it = flatItems[i];
        if (String(it.ayah) === String(rule.posAyah) && String(it.wordPos) === String(rule.posWordStart)) {
          rule.lastMatchCount = (rule.lastMatchCount || 0) + 1;
          it.displayText = ''; it.code = it.codeV2 || ''; it.displayColor = ''; it.displayBg = ''; it.displayStroke = ''; it.meaning = ''; it.markColor = ''; it.hidden = false; it.sakinFlag = false;
        }
      }
    });
  }

  // --- القاعدة العامة التلقائية: صلة ميم الجمع على كل كلمة تنتهي بـ"ـهُمْ/ـهِمْ/ـكُمْ/ـتُمْ" ---
  const MEEM_JAMA_SUFFIX_RE = /[\u0647\u0643\u062A][\u064F\u0650]\u0645\u0652$/;
  function isMeemJamaWord(text) { return MEEM_JAMA_SUFFIX_RE.test(text || ''); }
  function buildMeemJamaDisplay(text) {
    // بيبدّل السكون على الميم بضمة، وبيضيف واو الصلة الصغيرة (ۥ) بعدها مباشرة
    return (text || '').replace(/\u0652$/, '\u064F') + '\u06E5';
  }
  // options: { enabled: boolean, exceptions: string[] } — كل مصحف بيمرّر إعداداته الخاصة (ومخزّنها بنفسه).
  function applyMeemJamaRule(flatItems, surahNum, options) {
    const opts = options || {};
    if (!opts.enabled || !flatItems.length) return;
    const exceptions = opts.exceptions || [];
    for (let i = 0; i < flatItems.length; i++) {
      const item = flatItems[i];
      if (item.hidden || item.displayText) continue; // كلمة اتغيرت بالفعل بقاعدة يدوية — نسيبها زي ما القاعدة اليدوية عملتها
      if (!isMeemJamaWord(item.text)) continue;
      const ayahKey = String(item.ayah); const posKey = `${ayahKey}:${item.wordPos}`;
      if (exceptions.includes(ayahKey) || exceptions.includes(posKey)) continue;
      const nextItem = flatItems[i + 1];
      const decision = evaluateWaslNeighbor(nextItem, lastArabicLetterOf(item.text));
      if (decision.skip) continue;
      if (decision.softenedNextText) { nextItem.displayText = decision.softenedNextText; nextItem.code = ''; }
      item.displayText = buildMeemJamaDisplay(item.text); item.code = '';
    }
  }

  return {
    normalizeArabic,
    parseManualExceptions,
    lastArabicLetterOf,
    evaluateWaslNeighbor,
    applyWordRules,
    isMeemJamaWord,
    buildMeemJamaDisplay,
    applyMeemJamaRule,
  };
})();

// دعم الاستخدام في Node (للاختبار) بالإضافة للمتصفح
if (typeof module !== 'undefined' && module.exports) module.exports = TajweedEngine;
