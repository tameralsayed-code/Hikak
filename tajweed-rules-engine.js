/*
 * tajweed-rules-engine.js
 * محرك قواعد الرسم القرآني المشترك — مستقل عن أي مصحف أو رواية بعينها.
 *
 * ده محرك بحث/استبدال خام بس: بياخد قواعد كلمات (نص أصلي → نص جديد، أو تلوين/معنى) ويطبّقها
 * على مصفوفة كلمات. مفيهوش أي افتراض عن الوصل أو ميم الجمع أو أي سلوك تجويدي — ده كله
 * خاص بكل رواية على حدة وبيتحط في ملفها (زي mushafs/bazzi-rules.js).
 *
 * لو رواية معينة محتاجة سلوك إضافي وقت تطبيق قاعدة (زي: افحص الكلمة التالية قبل ما تطبّق)،
 * تقدر تمرّر onNewTextApplied في الـ options — دالة بتاخد (nextItem, currentItem) وترجع
 * { skip, softenedNextText } — والمحرك هيستخدمها بس لو اتمررت، من غير أي منطق مدمج جواه.
 *
 * ده ملف "منطق خالص" (pure functions): مفيهوش تخزين (localStorage) ولا واجهة (HTML/CSS)
 * ولا بيانات آيات. كل دالة بتاخد الحالة اللي محتاجاها (قواعد الكلمات) كباراميتر، عشان كل
 * مشروع مصحف يفضل مالك بياناته وتخزينه وواجهته بنفسه.
 *
 * الاستخدام في أي مصحف جديد:
 *   <script src="tajweed-rules-engine.js"></script>
 *   ...
 *   TajweedEngine.applyWordRules(flatItems, surahNum, wordRules);
 *   // أو مع hook خاص برواية معينة:
 *   TajweedEngine.applyWordRules(flatItems, surahNum, wordRules, { onNewTextApplied: myHook });
 *
 * "flatItems" = مصفوفة كائنات كل واحد فيها: { text, ayah, wordPos, hidden, displayText, code, ... }
 * وهو نفس الشكل اللي كل مصاحف المشروع (البزي وغيره) بتستخدمه للكلمة الواحدة.
 *
 * عدّل هنا مرة واحدة لما تكتشف تصليح باج في آلية البحث/الاستبدال نفسها (مش قاعدة رواية-خاصة)،
 * وكل المصاحف اللي بتستخدم نسخة محدّثة من الملف ده بتاخد التعديل تلقائيًا.
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

  // --- تطبيق قواعد الكلمات اليدوية (بحث واستبدال / تلوين / معنى) على مصفوفة كلمات سورة واحدة ---
  // wordRules: مصفوفة القواعد الخاصة بالمصحف اللي بينادي الدالة (كل مصحف عنده نسخته ومخزّنها بنفسه).
  // options.onNewTextApplied(nextItem, currentItem): hook اختياري (رواية-خاص) بيتنادى قبل تطبيق
  // أي قاعدة فيها newText، وبيرجع { skip, softenedNextText } — لو من غيره، القاعدة بتتطبق عادي.
  function applyWordRules(flatItems, surahNum, wordRules, options) {
    const onNewTextApplied = (options && options.onNewTextApplied) || null;
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
          if (rule.newText && onNewTextApplied) {
            const nextItem = flatItems[i + n];
            const decision = onNewTextApplied(nextItem, flatItems[i]) || {};
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

  return {
    normalizeArabic,
    parseManualExceptions,
    applyWordRules,
  };
})();

// دعم الاستخدام في Node (للاختبار) بالإضافة للمتصفح
if (typeof module !== 'undefined' && module.exports) module.exports = TajweedEngine;
