/**
 * schedule-app.js
 * 기간·인원·30분 격자, 토요일·평일구간 1.5배 집계, 통계, localStorage + JSON 파일
 */

(function () {
  "use strict";

  /** UI·배포 확인용(수정 배포 시 0.01씩 증가) */
  const APP_VERSION = "1.04";

  const SLOT_MINUTES = 30;
  const MULTIPLIER_WEIGHT = 1.5;
  /** 근무시간 select 선택 가능 범위 (08:00~22:00, 30분 단위) — 초기값은 아래 DEFAULT_* */
  const WORK_HOUR_SELECT_MIN = 8 * 60;
  const WORK_HOUR_SELECT_MAX = 22 * 60;
  const DEFAULT_WORK_START = "08:30";
  const DEFAULT_WORK_END = "21:00";
  const MAX_PEOPLE = 10;
  /** 달력에 표시할 요일 수 (월~토, 일요일 제외) */
  const DISPLAY_DAYS_MON_SAT = 6;
  const STORAGE_KEY = "clinicSchedule_v1";
  const EXPORT_FILE_VERSION = 1;
  /** 시간 설정 기본값(30분 격자) — 평일 1.5배·점심 초기 셀렉트 */
  const DEFAULT_WEEKDAY_MUL_START = "18:00";
  const DEFAULT_WEEKDAY_MUL_END = "21:00";
  const DEFAULT_LUNCH_START = "12:30";
  const DEFAULT_LUNCH_END = "14:00";
  /** 이름 칸 초기값(1~7번, 8~10은 빈칸) — 비어 있을 때만 채움 */
  const DEFAULT_PERSON_NAMES = [
    "김유진",
    "박수영",
    "심다혜",
    "기유라",
    "김찬미",
    "최예리",
    "장설아",
    "",
    "",
    "",
  ];
  const PERSON_COLORS = [
    "#93c5fd", "#86efac", "#fcd34d", "#f9a8d4", "#c4b5fd",
    "#5eead4", "#fca5a5", "#a5b4fc", "#fde047", "#6ee7b7",
  ];

  /**
   * 근무/표시용 슬롯 시작 시각(분) 목록
   * 종료 시각 endMin은 마감(해당 시각까지 근무)으로 보고, 각 행은 30분 칸의 시작이므로
   * 마지막 시작은 endMin 직전(예: 08:30~21:00 → 20:30~21:00 칸까지, 21:00 시작 행 없음)
   */
  function buildSlotMinutesList(startMin, endMin) {
    const list = [];
    for (let m = startMin; m + SLOT_MINUTES <= endMin; m += SLOT_MINUTES) {
      list.push(m);
    }
    return list;
  }

  /** 구버전 배정 키 `날짜|행번호` 해석용 — 당시는 21:00 시작 행까지 포함(구 격자와 동일해야 함) */
  const LEGACY_SLOT_MINUTES_LIST = (function () {
    const list = [];
    for (let m = 8 * 60 + 30; m <= 21 * 60; m += SLOT_MINUTES) {
      list.push(m);
    }
    return list;
  })();

  /** 근무 시작·종료 select 옵션(08:00~22:00) */
  function populateWorkHourSelect(selectEl) {
    if (!selectEl || selectEl.tagName !== "SELECT") return;
    selectEl.textContent = "";
    const frag = document.createDocumentFragment();
    for (let m = WORK_HOUR_SELECT_MIN; m <= WORK_HOUR_SELECT_MAX; m += SLOT_MINUTES) {
      const opt = document.createElement("option");
      const v = minutesToLabel(m);
      opt.value = v;
      opt.textContent = v;
      frag.appendChild(opt);
    }
    selectEl.appendChild(frag);
  }

  /** 근무시간 select 값이 옵션에 없으면 기본으로 */
  function normalizeWorkHourSelect(selectEl) {
    if (!selectEl || selectEl.tagName !== "SELECT" || !selectEl.options.length) return;
    const has = [...selectEl.options].some((o) => o.value === selectEl.value);
    if (!has) selectEl.value = selectEl.id === "workEnd" ? DEFAULT_WORK_END : DEFAULT_WORK_START;
  }

  /** "HH:MM" → 자정 기준 분 (실패 시 null) */
  function parseHHMMToMinutes(s) {
    if (typeof s !== "string" || !s) return null;
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  /** 분 값을 30분 격자로 스냅·클램프 (00:00~23:30) */
  function snapMinutesToHalfHourGrid(totalMin) {
    const snapped = Math.round(totalMin / SLOT_MINUTES) * SLOT_MINUTES;
    return Math.max(0, Math.min(24 * 60 - SLOT_MINUTES, snapped));
  }

  /** 시간 설정용 select에 30분 간격 옵션(00:00~23:30) 채우기 */
  function populateAsideTimeSelect(selectEl) {
    if (!selectEl || selectEl.tagName !== "SELECT") return;
    selectEl.textContent = "";
    const frag = document.createDocumentFragment();
    for (let m = 0; m < 24 * 60; m += SLOT_MINUTES) {
      const opt = document.createElement("option");
      const v = minutesToLabel(m);
      opt.value = v;
      opt.textContent = v;
      frag.appendChild(opt);
    }
    selectEl.appendChild(frag);
  }

  /** 불러오기 등으로 들어온 시각을 select 옵션에 맞게 보정 */
  function normalizeAsideTimeSelect(selectEl) {
    if (!selectEl || selectEl.tagName !== "SELECT" || !selectEl.options.length) return;
    const mins = parseHHMMToMinutes(selectEl.value);
    if (mins == null) {
      selectEl.selectedIndex = 0;
      return;
    }
    const hhmm = minutesToLabel(snapMinutesToHalfHourGrid(mins));
    if ([...selectEl.options].some((o) => o.value === hhmm)) selectEl.value = hhmm;
    else selectEl.selectedIndex = 0;
  }

  /**
   * 1.5배 적용 여부: 토요일(항상), 월~금은 [weekdayStartMin, weekdayEndMin) 반개구간
   * weekdayStartMin >= weekdayEndMin 이면 평일은 구간 없음
   */
  function isSlotMulFifteenForDate(dateObj, slotStartMin, weekdayStartMin, weekdayEndMin) {
    const dow = dateObj.getDay();
    if (dow === 6) return true;
    if (dow >= 1 && dow <= 5) {
      if (weekdayStartMin >= weekdayEndMin) return false;
      return slotStartMin >= weekdayStartMin && slotStartMin < weekdayEndMin;
    }
    return false;
  }

  /**
   * 점심 구간과 슬롯이 겹치면 true (월~금만). 시작≥종료면 점심 미사용
   * 슬롯 [slotStart, slotEnd) 와 [lunchStart, lunchEnd) 교집합
   */
  function isLunchSlotOverlap(dateObj, slotStartMin, lunchStartMin, lunchEndMin) {
    const dow = dateObj.getDay();
    if (dow < 1 || dow > 5) return false;
    if (lunchStartMin == null || lunchEndMin == null || lunchStartMin >= lunchEndMin) return false;
    const slotEnd = slotStartMin + SLOT_MINUTES;
    return slotStartMin < lunchEndMin && slotEnd > lunchStartMin;
  }

  /** Date → YYYY-MM-DD */
  function formatDateOnly(d) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }

  /** 다운로드 파일명용 로컬 날짜·시각(초) — Windows 금지 문자(: 등) 미사용 */
  function formatDateTimeForFileStamp(d) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${y}${mo}${da}_${h}${mi}${s}`;
  }

  /** YYYY-MM-DD 문자열 파싱 (로컬 자정) */
  function parseDateOnly(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  /** 해당 주 월요일 0시 */
  function startOfMonday(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = x.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    x.setDate(x.getDate() + diff);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  /** 월요일 시작 주의 대표 키 (해당 주 월요일 YYYY-MM-DD) */
  function weekKeyFromDate(d) {
    return formatDateOnly(startOfMonday(d));
  }

  /** 분 → "HH:MM" 표시 */
  function minutesToLabel(totalMin) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  /** 슬롯 인덱스로부터 기본 근무시간(시) */
  function baseHoursForSlot() {
    return SLOT_MINUTES / 60;
  }

  /** 배정 객체의 유효 근무시간(시) */
  function effectiveHours(isOnePointFive) {
    const base = baseHoursForSlot();
    return isOnePointFive ? base * MULTIPLIER_WEIGHT : base;
  }

  /** 기간 내 월요일 기준 주 키 나열 (순서 보존) */
  function enumerateWeekKeysInRange(startStr, endStr) {
    const start = parseDateOnly(startStr);
    const end = parseDateOnly(endStr);
    if (start > end) return [];
    const keys = [];
    const seen = new Set();
    const cur = new Date(start);
    while (cur <= end) {
      const k = weekKeyFromDate(cur);
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
      cur.setDate(cur.getDate() + 1);
    }
    return keys;
  }

  /** 기간 내 월 키 YYYY-MM */
  function enumerateMonthKeys(startStr, endStr) {
    const start = parseDateOnly(startStr);
    const end = parseDateOnly(endStr);
    const keys = [];
    let seen = new Set();
    const cur = new Date(start);
    while (cur <= end) {
      const k = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`;
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
      cur.setDate(cur.getDate() + 1);
    }
    return keys;
  }

  /** 슬롯 저장 키 — slotStartMin: 해당 칸 시작 시각(자정 기준 분) */
  function slotStorageKey(dateStr, slotStartMin) {
    return `${dateStr}|${slotStartMin}`;
  }

  /** 배정 키 두 번째 토큰 → 슬롯 시작 분(구버전 `날짜|행번호` 면 LEGACY 표로 변환) */
  function slotStartMinFromKey(key) {
    if (!key || typeof key !== "string") return null;
    const parts = key.split("|");
    if (parts.length !== 2) return null;
    const n = parseInt(parts[1], 10);
    if (Number.isNaN(n)) return null;
    if (n >= 0 && n < LEGACY_SLOT_MINUTES_LIST.length) return LEGACY_SLOT_MINUTES_LIST[n];
    return n;
  }

  /** localStorage/옛 JSON의 행 번호 키를 `날짜|시작분` 형식으로 통일 */
  function migrateAssignmentsToMinuteKeys(raw) {
    if (!raw || typeof raw !== "object") return {};
    const next = {};
    Object.keys(raw).forEach((k) => {
      try {
        const parts = k.split("|");
        if (parts.length !== 2) return;
        const dStr = parts[0];
        const n = parseInt(parts[1], 10);
        if (Number.isNaN(n)) return;
        const startMin = n < LEGACY_SLOT_MINUTES_LIST.length ? LEGACY_SLOT_MINUTES_LIST[n] : n;
        const nk = `${dStr}|${startMin}`;
        const ids = getSlotPersonIndexes(raw[k]);
        if (!ids.length) return;
        const prev = next[nk];
        if (prev) {
          const merged = [...new Set([...getSlotPersonIndexes(prev), ...ids])].sort((a, b) => a - b);
          next[nk] = { personIndexes: merged };
        } else {
          next[nk] = raw[k];
        }
      } catch (e) {
        console.error("migrateAssignmentsToMinuteKeys", k, e);
      }
    });
    return next;
  }

  /** 이름이 입력된 사람만(공백 제외) */
  function filterToNamedPersonIndices(names, ids) {
    return ids.filter((i) => typeof i === "number" && i >= 0 && i < MAX_PEOPLE && (names[i] || "").trim() !== "");
  }

  /** 슬롯 배정에서 유효한 personIndex 목록(정렬·중복 제거) */
  function getSlotPersonIndexes(assign) {
    if (!assign) return [];
    if (Array.isArray(assign.personIndexes)) {
      return [...new Set(assign.personIndexes.filter((i) => typeof i === "number" && i >= 0 && i < MAX_PEOPLE))].sort(
        (a, b) => a - b
      );
    }
    if (typeof assign.personIndex === "number" && assign.personIndex >= 0 && assign.personIndex < MAX_PEOPLE) {
      return [assign.personIndex];
    }
    return [];
  }

  /** 칸 표시용 이름(이름 없는 인덱스는 표시하지 않음 — 호출부에서 필터링) */
  function slotPersonDisplayName(names, index) {
    return (names[index] || "").trim();
  }

  /** 인원 수에 따라 그리드 열 수 클래스(가로·세로 배치) */
  function slotChipsColClass(count) {
    if (count <= 1) return "slot-chips--cols-1";
    if (count <= 4) return "slot-chips--cols-2";
    return "slot-chips--cols-3";
  }

  /** 상태 로드 */
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.error("loadState", e);
      return null;
    }
  }

  /** 상태 저장 */
  function saveState(payload) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.error("saveState", e);
    }
  }

  /** DOM이 로드된 뒤 앱 초기화 */
  function initApp() {
    const elAppVersion = document.getElementById("appVersion");
    if (elAppVersion) elAppVersion.textContent = `v${APP_VERSION}`;

    const elStart = document.getElementById("rangeStart");
    const elEnd = document.getElementById("rangeEnd");
    const elPeople = document.querySelectorAll(".person-name");
    const elCalendar = document.getElementById("calendarMain");
    const elWeekdayMulStart = document.getElementById("weekdayMulStart");
    const elWeekdayMulEnd = document.getElementById("weekdayMulEnd");
    const elLunchStart = document.getElementById("lunchStart");
    const elLunchEnd = document.getElementById("lunchEnd");
    const elWorkStart = document.getElementById("workStart");
    const elWorkEnd = document.getElementById("workEnd");
    populateWorkHourSelect(elWorkStart);
    populateWorkHourSelect(elWorkEnd);
    if (elWorkStart) elWorkStart.value = DEFAULT_WORK_START;
    if (elWorkEnd) elWorkEnd.value = DEFAULT_WORK_END;
    const asideTimeSelects = [elWeekdayMulStart, elWeekdayMulEnd, elLunchStart, elLunchEnd];
    asideTimeSelects.forEach((sel) => populateAsideTimeSelect(sel));
    /* 첫 옵션이 00:00으로 자동 선택되어 !value 체크로는 기본값이 안 들어가므로, localStorage 반영 전에 기본 시각 설정 */
    if (elWeekdayMulStart) elWeekdayMulStart.value = DEFAULT_WEEKDAY_MUL_START;
    if (elWeekdayMulEnd) elWeekdayMulEnd.value = DEFAULT_WEEKDAY_MUL_END;
    if (elLunchStart) elLunchStart.value = DEFAULT_LUNCH_START;
    if (elLunchEnd) elLunchEnd.value = DEFAULT_LUNCH_END;
    const elStats = document.getElementById("statsRoot");
    const elToast = document.getElementById("toast");
    const elPicker = document.getElementById("personPicker");

    let assignments = {};
    let selectedPersonIndex = 0;
    /** 우클릭 메뉴에서 복사한 personIndex 목록(null이면 복사 이력 없음) */
    let slotAssignmentClipboard = null;
    /** 상단 '복사하기'·'붙여넣기' 버튼으로 다음 클릭 칸에 적용(null | 'copy' | 'paste') */
    let slotPickMode = null;

    /** 평일 1.5배 구간(분) — 토요일은 항상 1.5배 */
    function getWeekdayMulMinutesBounds() {
      const sa = parseHHMMToMinutes(elWeekdayMulStart && elWeekdayMulStart.value);
      const sb = parseHHMMToMinutes(elWeekdayMulEnd && elWeekdayMulEnd.value);
      if (sa == null || sb == null) return { startMin: 0, endMin: 0 };
      return { startMin: sa, endMin: sb };
    }

    /** 현재 근무시간 설정에 따른 표·집계용 슬롯 시작 시각(분) 배열 */
    function getWorkSlotMinutesList() {
      const a = parseHHMMToMinutes(elWorkStart && elWorkStart.value);
      const b = parseHHMMToMinutes(elWorkEnd && elWorkEnd.value);
      if (a == null || b == null) {
        const ds = parseHHMMToMinutes(DEFAULT_WORK_START);
        const de = parseHHMMToMinutes(DEFAULT_WORK_END);
        if (ds == null || de == null) return buildSlotMinutesList(8 * 60 + 30, 21 * 60);
        return buildSlotMinutesList(ds, de);
      }
      let s0 = snapMinutesToHalfHourGrid(Math.min(a, b));
      let s1 = snapMinutesToHalfHourGrid(Math.max(a, b));
      s0 = Math.max(WORK_HOUR_SELECT_MIN, Math.min(s0, WORK_HOUR_SELECT_MAX));
      s1 = Math.max(WORK_HOUR_SELECT_MIN, Math.min(s1, WORK_HOUR_SELECT_MAX));
      if (s0 > s1) {
        const t = s0;
        s0 = s1;
        s1 = t;
      }
      return buildSlotMinutesList(s0, s1);
    }

    function isSlotMulForAssignment(d, slotStartMin) {
      const { startMin, endMin } = getWeekdayMulMinutesBounds();
      return isSlotMulFifteenForDate(d, slotStartMin, startMin, endMin);
    }

    function getLunchMinutesBounds() {
      const a = parseHHMMToMinutes(elLunchStart && elLunchStart.value);
      const b = parseHHMMToMinutes(elLunchEnd && elLunchEnd.value);
      if (a == null || b == null) return { startMin: 0, endMin: 0 };
      return { startMin: a, endMin: b };
    }

    function isLunchCell(d, slotStartMin) {
      const { startMin, endMin } = getLunchMinutesBounds();
      return isLunchSlotOverlap(d, slotStartMin, startMin, endMin);
    }

    /** 저장 전 월~금 점심 구간과 겹치는 배정 제거 */
    function pruneLunchAssignments() {
      Object.keys(assignments).forEach((k) => {
        const dStr = k.split("|")[0];
        const slotStartMin = slotStartMinFromKey(k);
        if (slotStartMin == null) return;
        const d = parseDateOnly(dStr);
        if (isLunchCell(d, slotStartMin)) delete assignments[k];
      });
    }

    /** 슬롯 키가 월~금 점심이면 배정·페인트 불가(토요일은 점심 없음·1.5배는 유지) */
    function isKeyBlockedByLunch(key) {
      if (!key) return true;
      const dStr = key.split("|")[0];
      const slotStartMin = slotStartMinFromKey(key);
      if (slotStartMin == null) return true;
      const d = parseDateOnly(dStr);
      return isLunchCell(d, slotStartMin);
    }

    /** 기간 flatpickr 인스턴스(2달 표시) */
    let fpRangeStart = null;
    let fpRangeEnd = null;

    /** 시작일·종료일 값 변경 후 저장 및 달력 갱신 */
    function onRangeDateInputsChanged() {
      persist();
      renderCalendar();
    }

    /** 파일 불러오기 등으로 input만 바뀐 뒤 flatpickr 표시와 동기화 */
    function syncFlatpickrRangeFromInputs() {
      try {
        if (!fpRangeStart || !fpRangeEnd) return;
        if (elStart.value) fpRangeStart.setDate(elStart.value, false);
        else fpRangeStart.clear();
        if (elEnd.value) fpRangeEnd.setDate(elEnd.value, false);
        else fpRangeEnd.clear();
      } catch (e) {
        console.error("syncFlatpickrRangeFromInputs", e);
      }
    }

    /** 시작·종료일: 한 번에 2달이 보이는 달력(Flatpickr) 연결 */
    function wireFlatpickrRangeInputs() {
      if (typeof flatpickr !== "function") {
        elStart.addEventListener("change", onRangeDateInputsChanged);
        elEnd.addEventListener("change", onRangeDateInputsChanged);
        return;
      }
      const localeKo =
        typeof flatpickr.l10ns !== "undefined" && flatpickr.l10ns.ko ? flatpickr.l10ns.ko : undefined;
      const opts = {
        dateFormat: "Y-m-d",
        showMonths: 2,
        allowInput: true,
        disableMobile: true,
        onChange: onRangeDateInputsChanged,
      };
      if (localeKo) opts.locale = localeKo;
      fpRangeStart = flatpickr(elStart, Object.assign({}, opts, { defaultDate: elStart.value || undefined }));
      /* 종료일 달력은 열 때 표시되는 2달의 기준 월을 시작일에 맞춤 */
      fpRangeEnd = flatpickr(
        elEnd,
        Object.assign({}, opts, {
          defaultDate: elEnd.value || undefined,
          onOpen: function (_selectedDates, _dateStr, instance) {
            let anchorDate = null;
            try {
              const startStr = elStart && elStart.value ? String(elStart.value).trim() : "";
              if (startStr) {
                const parsed = parseDateOnly(startStr);
                if (parsed && !Number.isNaN(parsed.getTime())) anchorDate = parsed;
              }
              if (!anchorDate) anchorDate = new Date();
              instance.jumpToDate(anchorDate);
            } catch (e) {
              console.error("fpRangeEnd onOpen", e);
              try {
                instance.jumpToDate(new Date());
              } catch (e2) {
                console.error("fpRangeEnd onOpen fallback", e2);
              }
            }
          },
        })
      );
    }

    const today = new Date();
    const defaultEnd = new Date(today);
    defaultEnd.setDate(defaultEnd.getDate() + 27);

    elStart.value = formatDateOnly(today);
    elEnd.value = formatDateOnly(defaultEnd);

    const restored = loadState();
    if (restored && restored.rangeStart && restored.rangeEnd) {
      elStart.value = restored.rangeStart;
      elEnd.value = restored.rangeEnd;
      if (Array.isArray(restored.names)) {
        elPeople.forEach((inp, i) => {
          if (restored.names[i]) inp.value = restored.names[i];
        });
      }
      if (restored.assignments && typeof restored.assignments === "object") {
        const tmp = {};
        Object.keys(restored.assignments).forEach((k) => {
          const a = restored.assignments[k];
          const ids = getSlotPersonIndexes(a);
          if (ids.length) tmp[k] = { personIndexes: ids };
        });
        assignments = migrateAssignmentsToMinuteKeys(tmp);
      }
      if (typeof restored.weekdayMulStart === "string" && restored.weekdayMulStart.trim() && elWeekdayMulStart) {
        elWeekdayMulStart.value = restored.weekdayMulStart;
      }
      if (typeof restored.weekdayMulEnd === "string" && restored.weekdayMulEnd.trim() && elWeekdayMulEnd) {
        elWeekdayMulEnd.value = restored.weekdayMulEnd;
      }
      if (typeof restored.lunchStart === "string" && restored.lunchStart.trim() && elLunchStart) {
        elLunchStart.value = restored.lunchStart;
      }
      if (typeof restored.lunchEnd === "string" && restored.lunchEnd.trim() && elLunchEnd) {
        elLunchEnd.value = restored.lunchEnd;
      }
      if (typeof restored.workStart === "string" && restored.workStart.trim() && elWorkStart) {
        elWorkStart.value = restored.workStart;
      }
      if (typeof restored.workEnd === "string" && restored.workEnd.trim() && elWorkEnd) {
        elWorkEnd.value = restored.workEnd;
      }
      if (typeof restored.selectedPersonIndex === "number") {
        selectedPersonIndex = Math.max(-1, Math.min(MAX_PEOPLE - 1, restored.selectedPersonIndex));
      }
    }

    /** localStorage·불러오기 반영 후에도 비어 있는 칸이면 기본 이름 표시 */
    elPeople.forEach((inp, i) => {
      try {
        const nm = DEFAULT_PERSON_NAMES[i];
        if (!(inp.value || "").trim() && nm) inp.value = nm;
      } catch (e) {
        console.error("default person name slot", e);
      }
    });

    asideTimeSelects.forEach((sel) => normalizeAsideTimeSelect(sel));
    normalizeWorkHourSelect(elWorkStart);
    normalizeWorkHourSelect(elWorkEnd);

    /** 토스트 메시지 */
    function showToast(msg) {
      elToast.textContent = msg;
      elToast.classList.add("is-visible");
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => elToast.classList.remove("is-visible"), 2200);
    }

    /** 배정 칸 우클릭 메뉴 DOM — 복사·붙여넣기·지우기 */
    const elSlotCtxMenu = document.createElement("div");
    elSlotCtxMenu.id = "slotContextMenu";
    elSlotCtxMenu.className = "slot-context-menu";
    elSlotCtxMenu.setAttribute("role", "menu");
    elSlotCtxMenu.hidden = true;
    ["복사하기", "붙여넣기", "지우기"].forEach((label, i) => {
      const actions = ["copy", "paste", "clear"];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slot-context-menu-item";
      btn.dataset.action = actions[i];
      btn.textContent = label;
      btn.setAttribute("role", "menuitem");
      elSlotCtxMenu.appendChild(btn);
    });
    document.body.appendChild(elSlotCtxMenu);

    let slotContextTargetKey = null;

    /** 컨텍스트 메뉴 닫기 */
    function hideSlotContextMenu() {
      slotContextTargetKey = null;
      elSlotCtxMenu.hidden = true;
      elSlotCtxMenu.classList.remove("is-open");
    }

    /** 뷰포트 안으로 메뉴 위치 보정 */
    function positionSlotContextMenuAt(clientX, clientY) {
      elSlotCtxMenu.style.left = `${clientX}px`;
      elSlotCtxMenu.style.top = `${clientY}px`;
      const rect = elSlotCtxMenu.getBoundingClientRect();
      const pad = 6;
      let x = clientX;
      let y = clientY;
      if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad;
      if (y + rect.height > window.innerHeight - pad) y = window.innerHeight - rect.height - pad;
      if (x < pad) x = pad;
      if (y < pad) y = pad;
      elSlotCtxMenu.style.left = `${x}px`;
      elSlotCtxMenu.style.top = `${y}px`;
    }

    /** 우클릭으로 메뉴 표시 */
    function openSlotContextMenu(clientX, clientY, key) {
      hidePersonNameContextMenu();
      slotContextTargetKey = key;
      elSlotCtxMenu.hidden = false;
      elSlotCtxMenu.classList.add("is-open");
      positionSlotContextMenuAt(clientX, clientY);
      requestAnimationFrame(() => positionSlotContextMenuAt(clientX, clientY));
    }

    /** 이름 입력칸 우클릭 메뉴 — 복사·붙여넣기·지우기(텍스트) */
    const elPersonNameCtxMenu = document.createElement("div");
    elPersonNameCtxMenu.id = "personNameContextMenu";
    elPersonNameCtxMenu.className = "slot-context-menu";
    elPersonNameCtxMenu.setAttribute("role", "menu");
    elPersonNameCtxMenu.hidden = true;
    ["복사하기", "붙여넣기", "지우기"].forEach((label, i) => {
      const actions = ["copy", "paste", "clear"];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slot-context-menu-item";
      btn.dataset.action = actions[i];
      btn.textContent = label;
      btn.setAttribute("role", "menuitem");
      elPersonNameCtxMenu.appendChild(btn);
    });
    document.body.appendChild(elPersonNameCtxMenu);

    let personNameCtxTarget = null;
    /** 이름 칸 간 복사(브라우저 시스템 클립보드와 별개) */
    let personNameTextClipboard = null;

    function hidePersonNameContextMenu() {
      personNameCtxTarget = null;
      elPersonNameCtxMenu.hidden = true;
      elPersonNameCtxMenu.classList.remove("is-open");
    }

    function positionPersonNameContextMenuAt(clientX, clientY) {
      elPersonNameCtxMenu.style.left = `${clientX}px`;
      elPersonNameCtxMenu.style.top = `${clientY}px`;
      const rect = elPersonNameCtxMenu.getBoundingClientRect();
      const pad = 6;
      let x = clientX;
      let y = clientY;
      if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad;
      if (y + rect.height > window.innerHeight - pad) y = window.innerHeight - rect.height - pad;
      if (x < pad) x = pad;
      if (y < pad) y = pad;
      elPersonNameCtxMenu.style.left = `${x}px`;
      elPersonNameCtxMenu.style.top = `${y}px`;
    }

    function openPersonNameContextMenu(clientX, clientY, inputEl) {
      hideSlotContextMenu();
      personNameCtxTarget = inputEl;
      elPersonNameCtxMenu.hidden = false;
      elPersonNameCtxMenu.classList.add("is-open");
      positionPersonNameContextMenuAt(clientX, clientY);
      requestAnimationFrame(() => positionPersonNameContextMenuAt(clientX, clientY));
    }

    elPersonNameCtxMenu.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const btn = ev.target && ev.target.closest && ev.target.closest("button[data-action]");
      if (!btn || !personNameCtxTarget) return;
      const action = btn.dataset.action;
      const inp = personNameCtxTarget;
      const maxLen = inp && inp.maxLength > 0 ? inp.maxLength : 20;
      try {
        if (action === "copy") {
          personNameTextClipboard = inp.value != null ? String(inp.value) : "";
          hidePersonNameContextMenu();
          showToast(personNameTextClipboard.trim() ? "이름을 복사했습니다." : "빈 칸을 복사했습니다.");
          return;
        }
        if (action === "paste") {
          if (personNameTextClipboard === null) {
            hidePersonNameContextMenu();
            showToast("복사한 이름이 없습니다. 먼저 복사하기를 선택하세요.");
            return;
          }
          inp.value = String(personNameTextClipboard).slice(0, maxLen);
          hidePersonNameContextMenu();
          persist();
          renderPersonPicker();
          renderCalendar();
          showToast("붙여넣었습니다.");
          return;
        }
        if (action === "clear") {
          inp.value = "";
          hidePersonNameContextMenu();
          persist();
          renderPersonPicker();
          renderCalendar();
          showToast("이름을 지웠습니다.");
        }
      } catch (e) {
        console.error("personNameContextMenu", e);
        hidePersonNameContextMenu();
        showToast("동작 처리 중 오류가 났습니다. 다시 시도해 주세요.");
      }
    });

    /**
     * 이름 입력 우클릭: document 캡처 + passive:false 로 기본 메뉴 차단
     * (일부 https 환경에서 input 버블만으로는 preventDefault가 먹지 않는 경우 대비)
     */
    document.addEventListener(
      "contextmenu",
      (ev) => {
        const nameInp = ev.target && ev.target.closest && ev.target.closest(".person-name");
        if (!nameInp) return;
        ev.preventDefault();
        ev.stopPropagation();
        openPersonNameContextMenu(ev.clientX, ev.clientY, nameInp);
      },
      { capture: true, passive: false }
    );

    elSlotCtxMenu.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const btn = ev.target && ev.target.closest && ev.target.closest("button[data-action]");
      if (!btn || !slotContextTargetKey) return;
      const action = btn.dataset.action;
      const key = slotContextTargetKey;
      const namesNow = getNames();
      try {
        if (action === "copy") {
          const ids = filterToNamedPersonIndices(namesNow, getSlotPersonIndexes(assignments[key]));
          slotAssignmentClipboard = [...ids];
          hideSlotContextMenu();
          showToast(ids.length ? "이 칸 배정을 복사했습니다." : "빈 칸을 복사했습니다. 붙여넣기 시 배정이 비워집니다.");
          return;
        }
        if (action === "paste") {
          if (slotAssignmentClipboard === null) {
            hideSlotContextMenu();
            showToast("복사한 내용이 없습니다. 먼저 복사하기를 선택하세요.");
            return;
          }
          if (isKeyBlockedByLunch(key)) {
            hideSlotContextMenu();
            showToast("점심 시간 칸에는 붙여넣을 수 없습니다.");
            return;
          }
          const ids = filterToNamedPersonIndices(namesNow, [...slotAssignmentClipboard]);
          if (ids.length === 0) delete assignments[key];
          else assignments[key] = { personIndexes: ids };
          hideSlotContextMenu();
          persist();
          renderCalendar();
          showToast("붙여넣었습니다.");
          return;
        }
        if (action === "clear") {
          delete assignments[key];
          hideSlotContextMenu();
          persist();
          renderCalendar();
          showToast("이 칸 배정을 지웠습니다.");
        }
      } catch (e) {
        console.error("slotContextMenu", e);
        hideSlotContextMenu();
        showToast("동작 처리 중 오류가 났습니다. 다시 시도해 주세요.");
      }
    });

    document.addEventListener(
      "click",
      (ev) => {
        if (elSlotCtxMenu.classList.contains("is-open") && !elSlotCtxMenu.contains(ev.target)) {
          hideSlotContextMenu();
        }
        if (elPersonNameCtxMenu.classList.contains("is-open") && !elPersonNameCtxMenu.contains(ev.target)) {
          hidePersonNameContextMenu();
        }
      },
      true
    );

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        if (elSlotCtxMenu.classList.contains("is-open")) hideSlotContextMenu();
        if (elPersonNameCtxMenu.classList.contains("is-open")) hidePersonNameContextMenu();
        if (slotPickMode) {
          clearSlotPickMode();
          showToast("취소했습니다.");
        }
      }
    });

    window.addEventListener(
      "scroll",
      () => {
        if (elSlotCtxMenu.classList.contains("is-open")) hideSlotContextMenu();
        if (elPersonNameCtxMenu.classList.contains("is-open")) hidePersonNameContextMenu();
      },
      true
    );

    /** 이름 배열 */
    function getNames() {
      return Array.from(elPeople).map((inp) => inp.value.trim() || "");
    }

    /** 저장 직전: 이름 없는 인덱스는 배정에서 제거, personIndexes만 유지 */
    function stripAssignmentExtras() {
      const names = getNames();
      const next = {};
      Object.keys(assignments).forEach((k) => {
        const ids = filterToNamedPersonIndices(names, getSlotPersonIndexes(assignments[k]));
        if (ids.length) next[k] = { personIndexes: ids };
      });
      assignments = next;
    }

    /** persist */
    function persist() {
      pruneLunchAssignments();
      stripAssignmentExtras();
      saveState({
        rangeStart: elStart.value,
        rangeEnd: elEnd.value,
        names: getNames(),
        assignments,
        weekdayMulStart: elWeekdayMulStart ? elWeekdayMulStart.value : "",
        weekdayMulEnd: elWeekdayMulEnd ? elWeekdayMulEnd.value : "",
        lunchStart: elLunchStart ? elLunchStart.value : "",
        lunchEnd: elLunchEnd ? elLunchEnd.value : "",
        workStart: elWorkStart ? elWorkStart.value : "",
        workEnd: elWorkEnd ? elWorkEnd.value : "",
        selectedPersonIndex,
      });
    }

    /** 내보낼 JSON 스냅샷 객체 생성 */
    function buildExportPayload() {
      pruneLunchAssignments();
      stripAssignmentExtras();
      return {
        version: EXPORT_FILE_VERSION,
        exportedAt: new Date().toISOString(),
        rangeStart: elStart.value,
        rangeEnd: elEnd.value,
        names: getNames(),
        assignments: JSON.parse(JSON.stringify(assignments)),
        weekdayMulStart: elWeekdayMulStart ? elWeekdayMulStart.value : "",
        weekdayMulEnd: elWeekdayMulEnd ? elWeekdayMulEnd.value : "",
        lunchStart: elLunchStart ? elLunchStart.value : "",
        lunchEnd: elLunchEnd ? elLunchEnd.value : "",
        workStart: elWorkStart ? elWorkStart.value : "",
        workEnd: elWorkEnd ? elWorkEnd.value : "",
        selectedPersonIndex,
      };
    }

    /** JSON 스냅샷을 화면·메모리·localStorage에 반영 */
    function applySnapshotPayload(raw) {
      if (!raw || typeof raw !== "object") {
        throw new Error("INVALID_JSON");
      }
      if (typeof raw.rangeStart === "string") elStart.value = raw.rangeStart;
      if (typeof raw.rangeEnd === "string") elEnd.value = raw.rangeEnd;
      if (Array.isArray(raw.names)) {
        elPeople.forEach((inp, i) => {
          inp.value = raw.names[i] != null ? String(raw.names[i]) : "";
        });
      }
      assignments = {};
      if (raw.assignments && typeof raw.assignments === "object") {
        const tmp = {};
        Object.keys(raw.assignments).forEach((k) => {
          const ids = getSlotPersonIndexes(raw.assignments[k]);
          if (ids.length) tmp[k] = { personIndexes: ids };
        });
        assignments = migrateAssignmentsToMinuteKeys(tmp);
      }
      if (elWorkStart) {
        elWorkStart.value =
          typeof raw.workStart === "string" && raw.workStart.trim() ? raw.workStart : DEFAULT_WORK_START;
      }
      if (elWorkEnd) {
        elWorkEnd.value =
          typeof raw.workEnd === "string" && raw.workEnd.trim() ? raw.workEnd : DEFAULT_WORK_END;
      }
      if (elWeekdayMulStart) {
        elWeekdayMulStart.value =
          typeof raw.weekdayMulStart === "string" && raw.weekdayMulStart.trim()
            ? raw.weekdayMulStart
            : DEFAULT_WEEKDAY_MUL_START;
      }
      if (elWeekdayMulEnd) {
        elWeekdayMulEnd.value =
          typeof raw.weekdayMulEnd === "string" && raw.weekdayMulEnd.trim()
            ? raw.weekdayMulEnd
            : DEFAULT_WEEKDAY_MUL_END;
      }
      if (elLunchStart) {
        elLunchStart.value =
          typeof raw.lunchStart === "string" && raw.lunchStart.trim() ? raw.lunchStart : DEFAULT_LUNCH_START;
      }
      if (elLunchEnd) {
        elLunchEnd.value =
          typeof raw.lunchEnd === "string" && raw.lunchEnd.trim() ? raw.lunchEnd : DEFAULT_LUNCH_END;
      }
      if (typeof raw.selectedPersonIndex === "number") {
        selectedPersonIndex = Math.max(-1, Math.min(MAX_PEOPLE - 1, raw.selectedPersonIndex));
      }
      asideTimeSelects.forEach((sel) => normalizeAsideTimeSelect(sel));
      normalizeWorkHourSelect(elWorkStart);
      normalizeWorkHourSelect(elWorkEnd);
      syncFlatpickrRangeFromInputs();
      stripAssignmentExtras();
      persist();
      renderPersonPicker();
      renderCalendar();
      showToast("파일에서 불러왔습니다.");
    }

    /**
     * JSON 스냅샷을 파일로 내려받기
     * @param {boolean} isSkipToast 닫기 직전 등 토스트를 띄울 수 없을 때 true
     */
    function downloadScheduleExportJson(isSkipToast) {
      try {
        const payload = buildExportPayload();
        const text = JSON.stringify(payload, null, 2);
        const blob = new Blob([text], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const stamp = formatDateTimeForFileStamp(new Date());
        a.href = url;
        a.download = `근무스케줄_${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        if (!isSkipToast) showToast("파일로 저장했습니다.");
      } catch (e) {
        console.error("downloadScheduleExportJson", e);
        if (!isSkipToast) showToast("파일 저장 중 오류가 났습니다. 다시 시도해 주세요.");
      }
    }

    /** 스케줄을 JSON 파일로 다운로드 */
    function exportScheduleToFile() {
      downloadScheduleExportJson(false);
    }

    /** JSON 파일 내용 파싱 후 적용 */
    function importScheduleFromText(text) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error("importScheduleFromText parse", e);
        showToast("JSON 형식이 아닙니다. 저장했던 스케줄 파일인지 확인하세요.");
        return;
      }
      try {
        applySnapshotPayload(data);
      } catch (e) {
        console.error("importScheduleFromText apply", e);
        showToast("파일 내용을 적용할 수 없습니다.");
      }
    }

    /** 드래그로 여러 칸에 배정할 때 포인터 상태(Alt+드래그·클릭은 지우기, Ctrl+드래그는 붙여넣기) */
    const pointerPaint = {
      isDown: false,
      isDrag: false,
      isPasteDrag: false,
      isEraseDrag: false,
      startKey: null,
      startX: 0,
      startY: 0,
      DRAG_THRESHOLD_PX: 6,
    };

    /** 칸 클릭: 선택 인원 토글(추가/제거) */
    function applyToggleToSlotKey(key) {
      if (isKeyBlockedByLunch(key)) return;
      if (selectedPersonIndex < 0) {
        showToast("이름을 입력한 뒤 배정할 사람을 선택하세요.");
        return;
      }
      const namesNow = getNames();
      let ids = filterToNamedPersonIndices(namesNow, getSlotPersonIndexes(assignments[key]));
      const idx = selectedPersonIndex;
      if (ids.includes(idx)) ids = ids.filter((x) => x !== idx);
      else ids = [...ids, idx].sort((a, b) => a - b);
      if (ids.length === 0) delete assignments[key];
      else assignments[key] = { personIndexes: ids };
    }

    /** 드래그 중: 선택 인원을 칸에 추가(이미 있으면 유지) */
    function applyPaintToSlotKey(key) {
      if (isKeyBlockedByLunch(key)) return;
      if (selectedPersonIndex < 0 || !key) return;
      const namesNow = getNames();
      let ids = filterToNamedPersonIndices(namesNow, getSlotPersonIndexes(assignments[key]));
      const idx = selectedPersonIndex;
      if (ids.includes(idx)) return;
      ids = [...ids, idx].sort((a, b) => a - b);
      assignments[key] = { personIndexes: ids };
    }

    /** Ctrl+드래그 붙여넣기: 복사해 둔 배정으로 칸 전체를 덮어씀 */
    function applyPasteToSlotKey(key) {
      if (!key || isKeyBlockedByLunch(key)) return;
      if (slotAssignmentClipboard === null) return;
      const namesNow = getNames();
      const ids = filterToNamedPersonIndices(namesNow, [...slotAssignmentClipboard]);
      if (ids.length === 0) delete assignments[key];
      else assignments[key] = { personIndexes: ids };
    }

    /** Alt+클릭·드래그: 해당 칸 배정 삭제 */
    function applyEraseToSlotKey(key) {
      if (!key || isKeyBlockedByLunch(key)) return;
      delete assignments[key];
    }

    /** 상단 버튼으로 칸 복사 시 clipboard에 넣기 */
    function applySlotCopyFromKey(key) {
      const namesNow = getNames();
      const ids = filterToNamedPersonIndices(namesNow, getSlotPersonIndexes(assignments[key]));
      slotAssignmentClipboard = [...ids];
      showToast(ids.length ? "이 칸 배정을 복사했습니다." : "빈 칸을 복사했습니다. 붙여넣기 시 배정이 비워집니다.");
    }

    /** 상단 버튼으로 칸 붙여넣기(점심 칸은 불가) */
    function applySlotPasteFromKey(key) {
      if (!key) return;
      if (isKeyBlockedByLunch(key)) {
        showToast("점심 시간 칸에는 붙여넣을 수 없습니다.");
        return;
      }
      if (slotAssignmentClipboard === null) {
        showToast("복사한 내용이 없습니다. 먼저 복사하기를 선택하세요.");
        return;
      }
      applyPasteToSlotKey(key);
      showToast("붙여넣었습니다.");
    }

    function clearSlotPickMode() {
      slotPickMode = null;
      const btnC = document.getElementById("btnSlotCopyMode");
      const btnP = document.getElementById("btnSlotPasteMode");
      if (btnC) btnC.classList.remove("is-active");
      if (btnP) btnP.classList.remove("is-active");
    }

    function updateSlotPickModeButtons() {
      const btnC = document.getElementById("btnSlotCopyMode");
      const btnP = document.getElementById("btnSlotPasteMode");
      if (btnC) btnC.classList.toggle("is-active", slotPickMode === "copy");
      if (btnP) btnP.classList.toggle("is-active", slotPickMode === "paste");
    }

    /** 화면 좌표 아래의 배정 셀이면 해당 키에 페인트 */
    function paintHitAt(clientX, clientY) {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el || !el.closest) return;
      const host = el.closest("[data-slot-key]");
      if (!host || host.classList.contains("is-out")) return;
      const k = host.getAttribute("data-slot-key");
      if (k) applyPaintToSlotKey(k);
    }

    /** Ctrl+붙여넣기 드래그: 좌표 아래 칸에 복사 배정 적용 */
    function paintHitAtPaste(clientX, clientY) {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el || !el.closest) return;
      const host = el.closest("[data-slot-key]");
      if (!host || host.classList.contains("is-out")) return;
      const k = host.getAttribute("data-slot-key");
      if (k) applyPasteToSlotKey(k);
    }

    /** Alt+지우기 드래그: 좌표 아래 칸 배정 삭제 */
    function paintHitAtErase(clientX, clientY) {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el || !el.closest) return;
      const host = el.closest("[data-slot-key]");
      if (!host || host.classList.contains("is-out")) return;
      const k = host.getAttribute("data-slot-key");
      if (k) applyEraseToSlotKey(k);
    }

    /** 문서 이동: 드래그 임계 통과 시 페인트 모드 + 경로상 셀 채움 */
    function onPointerPaintMove(ev) {
      if (!pointerPaint.isDown) return;
      const cx = ev.clientX;
      const cy = ev.clientY;
      const dx = cx - pointerPaint.startX;
      const dy = cy - pointerPaint.startY;
      const th = pointerPaint.DRAG_THRESHOLD_PX;
      if (!pointerPaint.isDrag && dx * dx + dy * dy > th * th) {
        pointerPaint.isDrag = true;
        if (pointerPaint.startKey) {
          if (pointerPaint.isEraseDrag) applyEraseToSlotKey(pointerPaint.startKey);
          else if (pointerPaint.isPasteDrag) applyPasteToSlotKey(pointerPaint.startKey);
          else applyPaintToSlotKey(pointerPaint.startKey);
        }
      }
      if (pointerPaint.isDrag) {
        if (pointerPaint.isEraseDrag) paintHitAtErase(cx, cy);
        else if (pointerPaint.isPasteDrag) paintHitAtPaste(cx, cy);
        else paintHitAt(cx, cy);
      }
    }

    /** 문서에서 떼기: 드래그 없었으면 시작 칸만 토글·붙여넣기·지우기, 이후 저장·다시 그리기 */
    function onPointerPaintUp() {
      if (!pointerPaint.isDown) return;
      const wasDrag = pointerPaint.isDrag;
      if (!wasDrag && pointerPaint.startKey) {
        if (pointerPaint.isEraseDrag) applyEraseToSlotKey(pointerPaint.startKey);
        else if (pointerPaint.isPasteDrag) applyPasteToSlotKey(pointerPaint.startKey);
        else applyToggleToSlotKey(pointerPaint.startKey);
      }
      pointerPaint.isDown = false;
      pointerPaint.isDrag = false;
      pointerPaint.isPasteDrag = false;
      pointerPaint.isEraseDrag = false;
      pointerPaint.startKey = null;
      persist();
      renderCalendar();
    }

    /** 인물 칩 UI — 이름이 입력된 사람만 표시 */
    function renderPersonPicker() {
      const names = getNames();
      elPicker.innerHTML = "";
      const namedIndices = [];
      for (let i = 0; i < MAX_PEOPLE; i++) {
        if ((names[i] || "").trim()) namedIndices.push(i);
      }
      if (namedIndices.length === 0) {
        selectedPersonIndex = -1;
        const p = document.createElement("p");
        p.className = "picker-empty-hint";
        p.textContent = "위쪽 이름 칸에 이름을 입력하면 여기에서 배정할 사람을 선택할 수 있습니다.";
        elPicker.appendChild(p);
        return;
      }
      if (!namedIndices.includes(selectedPersonIndex)) {
        selectedPersonIndex = namedIndices[0];
      }
      namedIndices.forEach((i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "person-chip" + (i === selectedPersonIndex ? " is-selected" : "");
        const sw = document.createElement("span");
        sw.className = "person-swatch";
        sw.style.background = PERSON_COLORS[i % PERSON_COLORS.length];
        btn.appendChild(sw);
        btn.appendChild(document.createTextNode(names[i].trim()));
        btn.addEventListener("click", () => {
          selectedPersonIndex = i;
          renderPersonPicker();
          persist();
        });
        elPicker.appendChild(btn);
      });
    }

    /**
     * 직전 주(월요일 prevWeekMonday)와 같은 요일·시간대 배정을 이번 주(월요일 currWeekMonday)로 복사
     * 기간·점심 칸은 제외하고, 현재 이름 목록 기준으로만 유효 인덱스 저장
     */
    function applyAssignmentsCopyFromPreviousWeek(prevWeekMonday, currWeekMonday, rangeStart, rangeEnd) {
      const namesNow = getNames();
      const slotList = getWorkSlotMinutesList();
      const nSlots = slotList.length;
      for (let di = 0; di < DISPLAY_DAYS_MON_SAT; di++) {
        const prevD = new Date(prevWeekMonday);
        prevD.setDate(prevD.getDate() + di);
        const currD = new Date(currWeekMonday);
        currD.setDate(currD.getDate() + di);

        if (currD < rangeStart || currD > rangeEnd) continue;

        for (let si = 0; si < nSlots; si++) {
          const slotStartMin = slotList[si];
          const currDStr = formatDateOnly(currD);
          const currKey = slotStorageKey(currDStr, slotStartMin);

          if (isLunchCell(currD, slotStartMin)) {
            delete assignments[currKey];
            continue;
          }

          if (prevD < rangeStart || prevD > rangeEnd || isLunchCell(prevD, slotStartMin)) {
            delete assignments[currKey];
            continue;
          }

          const prevKey = slotStorageKey(formatDateOnly(prevD), slotStartMin);
          const ids = filterToNamedPersonIndices(namesNow, getSlotPersonIndexes(assignments[prevKey]));
          if (ids.length === 0) delete assignments[currKey];
          else assignments[currKey] = { personIndexes: [...ids] };
        }
      }
    }

    /** 주별 달력 테이블 렌더 */
    function renderCalendar() {
      const startStr = elStart.value;
      const endStr = elEnd.value;
      const start = parseDateOnly(startStr);
      const end = parseDateOnly(endStr);

      elCalendar.innerHTML = "";

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        elCalendar.textContent = "날짜를 올바르게 선택해 주세요.";
        renderStats();
        return;
      }

      if (start > end) {
        elCalendar.textContent = "시작일이 종료일보다 늦을 수 없습니다.";
        renderStats();
        return;
      }

      const weekStart = startOfMonday(start);
      const weekEnd = startOfMonday(end);

      let displayedWeekIndex = 0;
      for (let ws = new Date(weekStart); ws <= weekEnd; ws.setDate(ws.getDate() + 7)) {
        const block = document.createElement("div");
        block.className = "week-block";

        const title = document.createElement("div");
        title.className = "week-title";
        const wEnd = new Date(ws);
        wEnd.setDate(wEnd.getDate() + (DISPLAY_DAYS_MON_SAT - 1));
        const rangeLine = `주 (월~토): ${formatDateOnly(ws)} ~ ${formatDateOnly(wEnd)}`;

        if (displayedWeekIndex >= 1) {
          title.classList.add("week-title--with-copy");
          const rangeSpan = document.createElement("span");
          rangeSpan.className = "week-title-range";
          rangeSpan.textContent = rangeLine;
          const btnCopyPrev = document.createElement("button");
          btnCopyPrev.type = "button";
          btnCopyPrev.className = "btn-panel btn-copy-prev-week";
          btnCopyPrev.textContent = "이전 주 복제하기";
          const currWeekMon = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate());
          const prevWeekMon = new Date(currWeekMon.getTime());
          prevWeekMon.setDate(prevWeekMon.getDate() - 7);
          btnCopyPrev.addEventListener("click", () => {
            try {
              applyAssignmentsCopyFromPreviousWeek(prevWeekMon, currWeekMon, start, end);
              persist();
              renderCalendar();
              showToast("이전 주 배정을 그대로 적용했습니다.");
            } catch (e) {
              console.error("applyAssignmentsCopyFromPreviousWeek", e);
              showToast("복사 중 오류가 났습니다. 다시 시도해 주세요.");
            }
          });
          title.appendChild(rangeSpan);
          title.appendChild(btnCopyPrev);
        } else {
          title.textContent = rangeLine;
        }
        block.appendChild(title);
        displayedWeekIndex += 1;

        const tbl = document.createElement("table");
        tbl.className = "schedule-table";

        const thead = document.createElement("thead");
        const hr = document.createElement("tr");
        const th0 = document.createElement("th");
        th0.className = "time-col";
        th0.textContent = "시간";
        hr.appendChild(th0);

        for (let di = 0; di < DISPLAY_DAYS_MON_SAT; di++) {
          const dd = new Date(ws);
          dd.setDate(dd.getDate() + di);
          const th = document.createElement("th");
          th.className = "day-col";
          if (di === 5) th.classList.add("day-col-sat");
          const wd = ["월", "화", "수", "목", "금", "토"][di];
          th.textContent = `${wd} ${dd.getMonth() + 1}/${dd.getDate()}`;
          if (dd < start || dd > end) th.classList.add("is-out");
          hr.appendChild(th);
        }
        thead.appendChild(hr);
        tbl.appendChild(thead);

        const tbody = document.createElement("tbody");

        /** td에 배정 UI·이벤트 장착 */
        function mountAssignableSlot(host, dStr, dd, slotStartMin) {
          if (isSlotMulForAssignment(dd, slotStartMin)) host.classList.add("slot-mul-hour");
          const key = slotStorageKey(dStr, slotStartMin);
          const names = getNames();
          const indexes = filterToNamedPersonIndices(names, getSlotPersonIndexes(assignments[key]));

          const inner = document.createElement("div");
          inner.className = "slot-inner";

          if (indexes.length > 0) {
            host.classList.add("has-assign");
            const wrap = document.createElement("div");
            wrap.className = "slot-chips-wrap";
            const chips = document.createElement("div");
            chips.className = `slot-chips ${slotChipsColClass(indexes.length)}`;
            indexes.forEach((pi) => {
              const chip = document.createElement("span");
              chip.className = "slot-chip";
              const label = slotPersonDisplayName(names, pi);
              chip.textContent = label;
              chip.title = label;
              chip.style.backgroundColor = PERSON_COLORS[pi % PERSON_COLORS.length];
              chips.appendChild(chip);
            });
            wrap.appendChild(chips);
            inner.appendChild(wrap);

            const cntEl = document.createElement("div");
            cntEl.className = "slot-assign-count";
            cntEl.textContent = String(indexes.length);
            cntEl.title = `배정 ${indexes.length}명`;
            inner.appendChild(cntEl);

            inner.style.backgroundColor = indexes.length === 1 ? "transparent" : "#f1f5f9";
            inner.style.borderLeft =
              indexes.length > 1 ? `2px solid ${PERSON_COLORS[indexes[0] % PERSON_COLORS.length]}` : "";
          }

          host.appendChild(inner);
          host.setAttribute("data-slot-key", key);

          host.addEventListener(
            "contextmenu",
            (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              openSlotContextMenu(ev.clientX, ev.clientY, key);
            },
            { passive: false }
          );
          host.addEventListener("mousedown", (ev) => {
            if (ev.button !== 0) return;
            if (slotPickMode === "copy" || slotPickMode === "paste") {
              ev.preventDefault();
              ev.stopPropagation();
              if (slotPickMode === "copy") applySlotCopyFromKey(key);
              else applySlotPasteFromKey(key);
              clearSlotPickMode();
              persist();
              renderCalendar();
              return;
            }
            ev.preventDefault();
            pointerPaint.isDown = true;
            pointerPaint.isDrag = false;
            pointerPaint.isEraseDrag = Boolean(ev.altKey);
            pointerPaint.isPasteDrag =
              !pointerPaint.isEraseDrag && Boolean(ev.ctrlKey && slotAssignmentClipboard !== null);
            pointerPaint.startKey = key;
            pointerPaint.startX = ev.clientX;
            pointerPaint.startY = ev.clientY;
          });
          host.addEventListener("mouseenter", () => {
            if (!pointerPaint.isDown || !pointerPaint.isDrag) return;
            if (pointerPaint.isEraseDrag) applyEraseToSlotKey(key);
            else if (pointerPaint.isPasteDrag) applyPasteToSlotKey(key);
            else applyPaintToSlotKey(key);
          });
          host.addEventListener(
            "touchstart",
            (ev) => {
              if (slotPickMode === "copy" || slotPickMode === "paste") {
                if (!ev.touches || ev.touches.length !== 1) return;
                ev.preventDefault();
                if (slotPickMode === "copy") applySlotCopyFromKey(key);
                else applySlotPasteFromKey(key);
                clearSlotPickMode();
                persist();
                renderCalendar();
                return;
              }
              if (!ev.touches || ev.touches.length !== 1) return;
              const t = ev.touches[0];
              pointerPaint.isDown = true;
              pointerPaint.isDrag = false;
              pointerPaint.isEraseDrag = false;
              pointerPaint.isPasteDrag = false;
              pointerPaint.startKey = key;
              pointerPaint.startX = t.clientX;
              pointerPaint.startY = t.clientY;
            },
            { passive: false }
          );
        }

        /** 한 슬롯 행의 월~토 칸 추가 */
        function appendDayCellsForSlot(trEl, slotStartMin) {
          for (let di = 0; di < DISPLAY_DAYS_MON_SAT; di++) {
            const dd = new Date(ws);
            dd.setDate(dd.getDate() + di);
            const dStr = formatDateOnly(dd);
            const isOut = dd < start || dd > end;

            const td = document.createElement("td");
            td.className = "slot-cell" + (isOut ? " is-out" : "");

            const lunchHere = !isOut && isLunchCell(dd, slotStartMin);
            if (lunchHere) td.classList.add("is-lunch");

            if (!isOut && lunchHere) {
              trEl.appendChild(td);
              continue;
            }

            if (!isOut) mountAssignableSlot(td, dStr, dd, slotStartMin);

            trEl.appendChild(td);
          }
        }

        const slotList = getWorkSlotMinutesList();
        const nSlots = slotList.length;
        for (let si = 0; si < nSlots; si++) {
          const slotStartMin = slotList[si];
          const tr = document.createElement("tr");
          const tTime = document.createElement("th");
          tTime.className = "time-col";
          tTime.textContent = minutesToLabel(slotStartMin);
          tr.appendChild(tTime);
          appendDayCellsForSlot(tr, slotStartMin);
          tbody.appendChild(tr);
        }
        tbl.appendChild(tbody);
        block.appendChild(tbl);
        elCalendar.appendChild(block);
      }

      renderStats();
    }

    /** 통계 테이블: 주평균 근무시간, 월별 근무시간 */
    function renderStats() {
      const startStr = elStart.value;
      const endStr = elEnd.value;
      const start = parseDateOnly(startStr);
      const end = parseDateOnly(endStr);
      elStats.innerHTML = "";

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
        return;
      }

      const weekKeys = enumerateWeekKeysInRange(startStr, endStr);
      const monthKeys = enumerateMonthKeys(startStr, endStr);
      const numWeeks = weekKeys.length || 1;

      const names = getNames();
      const workSlotSet = new Set(getWorkSlotMinutesList());

      const perPersonWeekTotals = Array.from({ length: MAX_PEOPLE }, () =>
        Object.fromEntries(weekKeys.map((k) => [k, 0]))
      );
      const perPersonMonthTotals = Array.from({ length: MAX_PEOPLE }, () =>
        Object.fromEntries(monthKeys.map((k) => [k, 0]))
      );

      Object.keys(assignments).forEach((key) => {
        const dStr = key.split("|")[0];
        const slotStartMin = slotStartMinFromKey(key);
        const d = parseDateOnly(dStr);
        if (d < start || d > end) return;
        if (d.getDay() === 0) return;
        if (slotStartMin == null) return;
        if (!workSlotSet.has(slotStartMin)) return;
        if (isLunchCell(d, slotStartMin)) return;

        const ids = filterToNamedPersonIndices(names, getSlotPersonIndexes(assignments[key]));
        if (!ids.length) return;

        const h = effectiveHours(isSlotMulForAssignment(d, slotStartMin));
        const wk = weekKeyFromDate(d);
        const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        ids.forEach((pid) => {
          if (perPersonWeekTotals[pid][wk] != null) perPersonWeekTotals[pid][wk] += h;
          if (perPersonMonthTotals[pid][mk] != null) perPersonMonthTotals[pid][mk] += h;
        });
      });

      const tbl = document.createElement("table");
      tbl.className = "stats-table";
      const head = document.createElement("thead");
      const hr = document.createElement("tr");
      ["이름", "평균 주간 근무(시간)", "월별 근무(시간)"].forEach((t) => {
        const th = document.createElement("th");
        th.textContent = t;
        hr.appendChild(th);
      });
      head.appendChild(hr);
      tbl.appendChild(head);

      const tb = document.createElement("tbody");
      let namedRowCount = 0;
      for (let i = 0; i < MAX_PEOPLE; i++) {
        const nm = (names[i] || "").trim();
        if (!nm) continue;
        namedRowCount++;
        const tr = document.createElement("tr");
        const tdN = document.createElement("td");
        tdN.textContent = nm;
        const tdAvg = document.createElement("td");
        const sumWeeks = weekKeys.reduce((s, k) => s + perPersonWeekTotals[i][k], 0);
        const avg = sumWeeks / numWeeks;
        tdAvg.textContent = avg.toFixed(2);

        const tdMo = document.createElement("td");
        const parts = monthKeys.map((mk) => {
          const v = perPersonMonthTotals[i][mk];
          return `${mk}: ${v.toFixed(2)}h`;
        });
        const sub = document.createElement("div");
        sub.className = "month-breakdown";
        sub.textContent = parts.join(" · ");
        tdMo.appendChild(sub);

        tr.appendChild(tdN);
        tr.appendChild(tdAvg);
        tr.appendChild(tdMo);
        tb.appendChild(tr);
      }
      if (namedRowCount === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 3;
        td.className = "stats-empty-hint";
        td.textContent = "이름이 입력된 사람이 있을 때만 집계 행이 표시됩니다.";
        tr.appendChild(td);
        tb.appendChild(tr);
      }
      tbl.appendChild(tb);
      elStats.appendChild(tbl);
    }

    document.addEventListener("mousemove", onPointerPaintMove);
    document.addEventListener("mouseup", onPointerPaintUp);
    document.addEventListener("touchmove", (ev) => {
      if (!pointerPaint.isDown || !ev.touches || ev.touches.length !== 1) return;
      const t = ev.touches[0];
      onPointerPaintMove({ clientX: t.clientX, clientY: t.clientY });
    }, { passive: true });
    document.addEventListener("touchend", onPointerPaintUp, { passive: true });
    document.addEventListener("touchcancel", onPointerPaintUp, { passive: true });

    /** 시간 설정(select, 30분 옵션만) 변경 시 저장·달력 갱신 */
    function onScheduleTimeChange() {
      persist();
      renderCalendar();
    }
    asideTimeSelects.forEach((el) => {
      el?.addEventListener("change", onScheduleTimeChange);
    });
    [elWorkStart, elWorkEnd].forEach((el) => {
      el?.addEventListener("change", onScheduleTimeChange);
    });
    elPeople.forEach((inp) => {
      inp.addEventListener("input", () => {
        persist();
        renderPersonPicker();
        renderCalendar();
      });
    });

    /** 시간표 칸 복사·붙여넣기: 버튼으로 모드 선택 후 칸 클릭 */
    document.getElementById("btnSlotCopyMode")?.addEventListener("click", () => {
      try {
        if (slotPickMode === "copy") {
          clearSlotPickMode();
          showToast("복사 모드를 취소했습니다.");
          return;
        }
        slotPickMode = "copy";
        updateSlotPickModeButtons();
        showToast("복사할 칸을 클릭하세요.");
      } catch (e) {
        console.error("btnSlotCopyMode", e);
        showToast("동작을 시작할 수 없습니다.");
      }
    });
    document.getElementById("btnSlotPasteMode")?.addEventListener("click", () => {
      try {
        if (slotPickMode === "paste") {
          clearSlotPickMode();
          showToast("붙여넣기 모드를 취소했습니다.");
          return;
        }
        if (slotAssignmentClipboard === null) {
          showToast("복사한 배정이 없습니다. 먼저 복사하기로 칸을 복사하세요.");
          return;
        }
        slotPickMode = "paste";
        updateSlotPickModeButtons();
        showToast("붙여넣을 칸을 클릭하세요.");
      } catch (e) {
        console.error("btnSlotPasteMode", e);
        showToast("동작을 시작할 수 없습니다.");
      }
    });

    document.getElementById("btnExportSchedule")?.addEventListener("click", () => {
      exportScheduleToFile();
    });

    /** 새로고침과 탭 닫기 구분(완벽하진 않으나 F5 시 매번 다운로드되는 것을 줄임) */
    function isLikelyPageReload() {
      try {
        if (typeof performance.navigation !== "undefined" && performance.navigation.type === 1) return true;
        const ent = performance.getEntriesByType("navigation")[0];
        return Boolean(ent && ent.type === "reload");
      } catch (e) {
        return false;
      }
    }

    /** 창·탭을 닫거나 다른 페이지로 갈 때 저장 확정 후 JSON 다운로드 시도(브라우저·설정에 따라 차단 가능) */
    window.addEventListener("pagehide", (ev) => {
      try {
        persist();
        if (!ev.persisted && !isLikelyPageReload()) downloadScheduleExportJson(true);
      } catch (err) {
        console.error("pagehide auto export", err);
      }
    });

    const elFileImport = document.getElementById("fileImportSchedule");
    document.getElementById("btnImportSchedule")?.addEventListener("click", () => {
      elFileImport?.click();
    });
    elFileImport?.addEventListener("change", () => {
      const file = elFileImport.files && elFileImport.files[0];
      elFileImport.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        importScheduleFromText(String(reader.result || ""));
      };
      reader.onerror = () => {
        console.error("file read", reader.error);
        showToast("파일을 읽는 중 오류가 났습니다.");
      };
      reader.readAsText(file, "UTF-8");
    });

    document.getElementById("btnResetSchedule")?.addEventListener("click", () => {
      if (
        !confirm(
          "모든 배정을 지웁니다.\n(이름·기간·평일 1.5배 시간 설정은 유지됩니다.)\n계속할까요?"
        )
      ) {
        return;
      }
      assignments = {};
      persist();
      renderPersonPicker();
      renderCalendar();
      showToast("배정 데이터를 초기화했습니다.");
    });

    document.getElementById("btnClearWeek")?.addEventListener("click", () => {
      if (!confirm("현재 기간 안의 모든 배정을 지울까요?")) return;
      const startStr = elStart.value;
      const endStr = elEnd.value;
      const start = parseDateOnly(startStr);
      const end = parseDateOnly(endStr);
      Object.keys(assignments).forEach((key) => {
        const [dStr] = key.split("|");
        const d = parseDateOnly(dStr);
        if (d >= start && d <= end) delete assignments[key];
      });
      persist();
      renderCalendar();
      showToast("기간 내 배정이 초기화되었습니다.");
    });

    wireFlatpickrRangeInputs();
    stripAssignmentExtras();
    renderPersonPicker();
    renderCalendar();
    persist();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
