// ==UserScript==
// @name         B站清澈人声-音量增强-动态音量平衡
// @namespace    https://www.bilibili.com/
// @version      1.15.3
// @description  为B站视频页与直播间播放器加入音频增强、自然响应动态响度平衡及播放器内实时状态条；网页全屏/全屏下由脚本接管滚轮（每次 1%）与上下方向键（每次 5%）调音量，普通模式沿用B站原生逻辑
// @license      MIT
// @match        *://bilibili.com/*
// @match        *://*.bilibili.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @sandbox      raw
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const PREFIX = 'bili-script-audio-enhancer-monitor';
  const STORAGE_PREFIX = 'bili-script-audio-enhancer';
  const MENU_LABEL = '音频增强（状态版）';
  const NORMALIZER_MENU_LABEL = '动态音量（状态版）';
  const NORMALIZER_DEFAULT_KEY = `${STORAGE_PREFIX}:normalizer-default-enabled`;
  const NORMALIZER_PRESET_DEFAULT_KEY = `${STORAGE_PREFIX}:normalizer-default-preset`;
  const NORMALIZER_SPEED_KEY = `${STORAGE_PREFIX}:normalizer-speed-preset`;
  const NORMALIZER_SPEED_PRESET_IDS = ['rapid', 'fast', 'balanced', 'gentle', 'slow'];
  const STATUS_HUD_ENABLED_KEY = `${STORAGE_PREFIX}:status-hud-enabled`;
  const STATUS_HUD_OPACITY_KEY = `${STORAGE_PREFIX}:status-hud-background-opacity`;
  const STATUS_HUD_OPACITY_OPTIONS = [0.25, 0.45, 0.65, 0.85];
  const STATUS_HUD_UPDATE_MS = 200;
  const BOOST_LIMITER_KEY = `${STORAGE_PREFIX}:boost-limiter-enabled`;
  const BOOST_MIN_PERCENT = 100;
  const BOOST_MAX_PERCENT = 1000;
  const BOOST_STEP_RATIO = 1.1;
  const WHEEL_VOLUME_DEFAULT_KEY = `${STORAGE_PREFIX}:wheel-volume-default-enabled`;
  // 100% 以内每次调整的档位：滚轮 1%，上下方向键 5%（贴近 B站 原生手感）
  const VOLUME_STEP_PERCENT = 1;
  const VOLUME_KEY_STEP_PERCENT = 5;
  const VOLUME_KEY_REPEAT_INTERVAL_MS = 90;
  // 视频页（bpx 播放器）与直播间（#live-player-ctnr / #live-player）的播放器根
  const PLAYER_SELECTOR = [
    '.bpx-player-container',
    '.bilibili-player-video-wrap',
    '#bilibili-player',
    '.bilibili-player',
    '#live-player-ctnr',
    '.live-player-ctnr',
    '#live-player',
    '.live-player-mounter',
  ].join(',');
  // 直播间播放器根（模式类标在它身上）与真正承载控制栏的那一层（播放器 SDK 运行时创建，隐藏时子节点跟着隐藏）
  const LIVE_PLAYER_CONTAINER_SELECTOR = '#live-player-ctnr, .live-player-ctnr';
  const LIVE_CONTROL_BAR_SELECTOR = '.web-player-controller-bg';
  // 直播间按钮在控制栏内的占位宽度（逐个向右排）
  const LIVE_TOOLBAR_SLOT_PX = 42;
  // 直播间的模式类：normal=普通模式，其余（web-full / fullscreen 等）按沉浸处理
  const LIVE_NORMAL_CLASS = 'normal';
  const LIVE_IMMERSIVE_CLASS_PATTERN = /webfull|web-full|screen-full|fullscreen|^full$|^web$/i;
  const VOLUME_WHEEL_SELECTOR = [
    '.bpx-player-ctrl-volume',
    '.bpx-player-rich-pip-volume',
    '.bpx-player-volume-panel',
    '.bilibili-player-video-btn-volume',
    '.bilibili-player-volume-panel',
    '[class*="ctrl-volume"]',
    '[class*="volume-panel"]',
    '[class*="volume-slider"]',
  ].join(',');
  let defaultNormalizerEnabled = loadNormalizerDefault();
  let defaultLoudnessPreset = loadDefaultLoudnessPreset();
  let normalizerSpeedPreset = loadNormalizerSpeedPreset();
  let statusHudEnabled = loadStatusHudEnabled();
  let statusHudOpacity = loadStatusHudOpacity();
  let boostLimiterEnabled = loadBoostLimiterEnabled();
  let wheelVolumeDefaultEnabled = loadWheelVolumeDefault();
  const DEFAULT_SETTINGS = {
    gainDB: 0,
    voicePreset: 'off',
    normalizerEnabled: defaultNormalizerEnabled,
    loudnessPreset: defaultLoudnessPreset,
    boostPercent: BOOST_MIN_PERCENT,
    wheelVolumeEnabled: wheelVolumeDefaultEnabled,
  };
  const LOUDNESS_PRESETS = {
    comfortable: -16,
    standard: -14,
    loud: -12,
  };
  // 不随响应速度变化的参数，其余参数由 NORMALIZER_SPEED_PROFILES 提供
  const NORMALIZER_BASE_CONFIG = {
    absoluteGateLUFS: -60,
    boostGateLUFS: -52,
    maxBoostDB: 12,
    maxCutDB: -12,
    limitDeadbandDB: 0.2,
  };
  const NORMALIZER_SPEED_PROFILES = {
    rapid: {
      momentaryMs: 160, shortTermMs: 650, historyMs: 4500, targetWindowMs: 180,
      warmupMs: 220, updateMs: 30, deadbandDB: 0.75, shortTermWeight: 0.9,
      boostHoldMs: 90, pauseHoldMs: 450, directionHoldMs: 90, fastCutThresholdDB: 2.5,
      boostRateDBPerSecond: 10.5, cutRateDBPerSecond: 24, emergencyCutRateDBPerSecond: 42,
      boostSmoothingSeconds: 0.1, cutSmoothingSeconds: 0.025,
      emergencyMarginLU: 7, emergencyHeadroomLU: 4,
    },
    fast: {
      momentaryMs: 220, shortTermMs: 1000, historyMs: 6500, targetWindowMs: 260,
      warmupMs: 320, updateMs: 40, deadbandDB: 0.9, shortTermWeight: 0.86,
      boostHoldMs: 140, pauseHoldMs: 600, directionHoldMs: 120, fastCutThresholdDB: 3,
      boostRateDBPerSecond: 8, cutRateDBPerSecond: 20, emergencyCutRateDBPerSecond: 36,
      boostSmoothingSeconds: 0.14, cutSmoothingSeconds: 0.035,
      emergencyMarginLU: 7.5, emergencyHeadroomLU: 4.5,
    },
    balanced: {
      momentaryMs: 300, shortTermMs: 1800, historyMs: 10000, targetWindowMs: 400,
      warmupMs: 500, updateMs: 50, deadbandDB: 1.05, shortTermWeight: 0.8,
      boostHoldMs: 220, pauseHoldMs: 750, directionHoldMs: 180, fastCutThresholdDB: 3.5,
      boostRateDBPerSecond: 5.5, cutRateDBPerSecond: 14, emergencyCutRateDBPerSecond: 30,
      boostSmoothingSeconds: 0.18, cutSmoothingSeconds: 0.045,
      emergencyMarginLU: 8, emergencyHeadroomLU: 5,
    },
    gentle: {
      momentaryMs: 420, shortTermMs: 2600, historyMs: 15000, targetWindowMs: 600,
      warmupMs: 700, updateMs: 75, deadbandDB: 1.2, shortTermWeight: 0.72,
      boostHoldMs: 340, pauseHoldMs: 900, directionHoldMs: 240, fastCutThresholdDB: 4,
      boostRateDBPerSecond: 3.8, cutRateDBPerSecond: 10, emergencyCutRateDBPerSecond: 24,
      boostSmoothingSeconds: 0.26, cutSmoothingSeconds: 0.06,
      emergencyMarginLU: 8.5, emergencyHeadroomLU: 5.5,
    },
    slow: {
      momentaryMs: 550, shortTermMs: 3800, historyMs: 22000, targetWindowMs: 900,
      warmupMs: 900, updateMs: 100, deadbandDB: 1.35, shortTermWeight: 0.65,
      boostHoldMs: 500, pauseHoldMs: 1100, directionHoldMs: 320, fastCutThresholdDB: 4.5,
      boostRateDBPerSecond: 2.7, cutRateDBPerSecond: 8, emergencyCutRateDBPerSecond: 20,
      boostSmoothingSeconds: 0.36, cutSmoothingSeconds: 0.085,
      emergencyMarginLU: 9, emergencyHeadroomLU: 6,
    },
  };
  const NORMALIZER_CONFIG = {
    ...NORMALIZER_BASE_CONFIG,
    ...NORMALIZER_SPEED_PROFILES[normalizerSpeedPreset],
  };
  const BILI_EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const BILI_SPOKEN_WORD_GAINS = [-4, -1, 0, 1, 4, 5, 5, 4, 2, 0];
  const VOICE_PROFILES = {
    a: {
      gainScale: 0.65,
      threshold: -20, knee: 30, ratio: 6, attack: 0.006, release: 0.25,
    },
    b: {
      gainScale: 1,
      threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25,
    },
    c: {
      gainScale: 1.2,
      threshold: -26, knee: 30, ratio: 14, attack: 0.003, release: 0.25,
    },
  };

  const audio = {
    ctx: null,
    sources: new WeakMap(),
    activeVideo: null,
    activeSource: null,
    nodes: null,
    error: '',
  };
  const loudness = {
    timer: null,
    leftData: null,
    rightData: null,
    blocks: [],
    currentGainDB: 0,
    momentaryLUFS: null,
    shortTermLUFS: null,
    programLUFS: null,
    desiredTargets: [],
    startedAt: 0,
    lastTickAt: 0,
    boostCandidateSince: 0,
    lastSignalAt: 0,
    activeDirection: 0,
    pendingDirection: 0,
    pendingDirectionSince: 0,
  };
  const autoApplyingVideos = new WeakSet();
  const boundScriptMenuItems = new WeakSet();

  let settings = { ...DEFAULT_SETTINGS };
  let activeVideoKey = getCurrentVideoKey();
  let lastContextVideo = null;
  let injectUntil = 0;
  let panel = null;
  let panelRefs = {};
  let panelVideo = null;
  let panelOpenedAt = 0;
  let panelCloseTimer = null;
  let normalizerPanel = null;
  let normalizerRefs = {};
  let normalizerPanelOpenedAt = 0;
  let normalizerCloseTimer = null;
  let toolbarScanScheduled = false;
  let toolbarFullScanAt = 0;
  const toolbarParents = new Set();
  // 直播间：脚本按钮的父节点是控制栏本身（跟着控制栏一起显隐），这里记录按钮与控制栏宿主
  const liveToolbarButtons = new Set();
  let liveControlBar = null;
  let liveControlBarObserver = null;
  const normalizerDefaultMenuIds = new Map();
  const normalizerSpeedMenuIds = new Map();
  const statusHudMenuIds = new Map();
  const boostMenuIds = new Map();
  const wheelVolumeMenuIds = new Map();
  let statusHud = null;
  let statusRefs = {};
  let statusHudTimer = null;
  let displayedLoudness = null;
  let displayedNormalizerGain = 0;
  const statusHudMetrics = {
    width: -1, height: -1, renderedWidth: 0, segments: -1, left: '', top: '',
  };

  function readSetting(key, fallback, normalize) {
    const coerce = (value) => (normalize ? normalize(value) : value);
    try {
      if (typeof GM_getValue === 'function') return coerce(GM_getValue(key, fallback));
    } catch (error) {}
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : coerce(raw);
    } catch (error) {
      return fallback;
    }
  }

  function writeSetting(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
      localStorage.setItem(key, String(value));
    } catch (error) {}
  }

  function asBoolean(value) {
    return value === true || value === 'true';
  }

  function loadNormalizerDefault() {
    return readSetting(NORMALIZER_DEFAULT_KEY, false, asBoolean);
  }

  function saveNormalizerDefault(value) {
    writeSetting(NORMALIZER_DEFAULT_KEY, Boolean(value));
  }

  function loadDefaultLoudnessPreset() {
    return readSetting(NORMALIZER_PRESET_DEFAULT_KEY, 'standard',
      (value) => (['comfortable', 'standard', 'loud'].includes(value) ? value : 'standard'));
  }

  function saveDefaultLoudnessPreset(value) {
    writeSetting(NORMALIZER_PRESET_DEFAULT_KEY, value);
  }

  function loadNormalizerSpeedPreset() {
    return readSetting(NORMALIZER_SPEED_KEY, 'balanced',
      (value) => (NORMALIZER_SPEED_PRESET_IDS.includes(value) ? value : 'balanced'));
  }

  function saveNormalizerSpeedPreset(value) {
    writeSetting(NORMALIZER_SPEED_KEY, value);
  }

  function loadStatusHudEnabled() {
    return readSetting(STATUS_HUD_ENABLED_KEY, true, asBoolean);
  }

  function saveStatusHudEnabled(value) {
    writeSetting(STATUS_HUD_ENABLED_KEY, Boolean(value));
  }

  function loadStatusHudOpacity() {
    return readSetting(STATUS_HUD_OPACITY_KEY, 0.45, (value) => {
      const number = Number(value);
      return STATUS_HUD_OPACITY_OPTIONS.includes(number) ? number : 0.45;
    });
  }

  function saveStatusHudOpacity(value) {
    writeSetting(STATUS_HUD_OPACITY_KEY, Number(value));
  }

  function loadBoostLimiterEnabled() {
    return readSetting(BOOST_LIMITER_KEY, true, asBoolean);
  }

  function saveBoostLimiterEnabled(value) {
    writeSetting(BOOST_LIMITER_KEY, Boolean(value));
  }

  function loadWheelVolumeDefault() {
    // 默认开启；因为滚轮只在网页全屏/全屏下才由脚本接管，普通模式下不会影响 B站 原生滚轮行为
    return readSetting(WHEEL_VOLUME_DEFAULT_KEY, true, asBoolean);
  }

  function saveWheelVolumeDefault(value) {
    writeSetting(WHEEL_VOLUME_DEFAULT_KEY, Boolean(value));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getCurrentVideoKey() {
    const params = new URLSearchParams(location.search);
    const identityParams = ['p', 'bvid', 'aid', 'cid', 'ep_id']
      .map((name) => params.has(name) ? `${name}=${params.get(name)}` : '')
      .filter(Boolean);
    return [location.pathname, ...identityParams].join('|');
  }

  function resetSettingsForNewVideo() {
    const nextVideoKey = getCurrentVideoKey();
    if (nextVideoKey === activeVideoKey) return false;

    activeVideoKey = nextVideoKey;
    settings = { ...DEFAULT_SETTINGS };
    hideVolumeOsd();
    applyAudioSettings();
    syncPanel();
    syncNormalizerPanel();
    return true;
  }

  function hasSavedEffect() {
    return settings.voicePreset !== 'off'
      || settings.gainDB !== 0
      || settings.normalizerEnabled
      || settings.boostPercent > BOOST_MIN_PERCENT;
  }

  function setParam(param, value, smoothing = 0.015) {
    if (!param || !audio.ctx) return;
    const now = audio.ctx.currentTime;
    param.cancelScheduledValues(now);
    if (smoothing > 0) param.setTargetAtTime(value, now, smoothing);
    else param.setValueAtTime(value, now);
  }

  function setAutoGainDB(gainDB, transitionSeconds) {
    if (!audio.ctx || !audio.nodes) return;
    const param = audio.nodes.autoGain.gain;
    const now = audio.ctx.currentTime;
    const target = Math.pow(10, gainDB / 20);
    const duration = Math.max(0.015, transitionSeconds);
    try {
      if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(now);
      } else {
        const current = param.value;
        param.cancelScheduledValues(now);
        param.setValueAtTime(current, now);
      }
      param.linearRampToValueAtTime(target, now + duration);
    } catch (error) {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(target, now, duration / 3);
    }
  }

  function buildAudioGraph() {
    if (audio.ctx) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('当前浏览器不支持 Web Audio API');

    const ctx = new AudioContextClass();
    const eqFilters = BILI_EQ_FREQUENCIES.map((frequency, index) => {
      const filter = ctx.createBiquadFilter();
      filter.type = index === 0
        ? 'lowshelf'
        : (index === BILI_EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking');
      filter.frequency.setValueAtTime(frequency, ctx.currentTime);
      filter.Q.value = 0.7;
      return filter;
    });
    const nodes = {
      input: ctx.createGain(),
      eqFilters,
      compressor: ctx.createDynamicsCompressor(),
      autoGain: ctx.createGain(),
      volumeGain: ctx.createGain(),
      boostGain: ctx.createGain(),
      limiter: ctx.createDynamicsCompressor(),
      meterShelf: ctx.createBiquadFilter(),
      meterHighpass: ctx.createBiquadFilter(),
      meterSplitter: ctx.createChannelSplitter(2),
      meterLeft: ctx.createAnalyser(),
      meterRight: ctx.createAnalyser(),
      meterSink: ctx.createGain(),
      meterConnected: false,
    };

    nodes.meterShelf.type = 'highshelf';
    nodes.meterShelf.frequency.setValueAtTime(1682, ctx.currentTime);
    nodes.meterShelf.gain.setValueAtTime(4, ctx.currentTime);
    nodes.meterHighpass.type = 'highpass';
    nodes.meterHighpass.frequency.setValueAtTime(38, ctx.currentTime);
    nodes.meterHighpass.Q.setValueAtTime(0.5, ctx.currentTime);
    nodes.meterLeft.fftSize = 4096;
    nodes.meterRight.fftSize = 4096;
    nodes.meterSink.gain.setValueAtTime(0, ctx.currentTime);

    nodes.input.connect(eqFilters[0]);
    for (let index = 1; index < eqFilters.length; index++) {
      eqFilters[index - 1].connect(eqFilters[index]);
    }
    eqFilters[eqFilters.length - 1].connect(nodes.compressor);
    nodes.compressor.connect(nodes.autoGain);
    nodes.autoGain.connect(nodes.volumeGain);
    nodes.volumeGain.connect(nodes.boostGain);
    nodes.boostGain.connect(nodes.limiter);
    nodes.limiter.connect(ctx.destination);

    audio.ctx = ctx;
    audio.nodes = nodes;
    loudness.leftData = new Float32Array(nodes.meterLeft.fftSize);
    loudness.rightData = new Float32Array(nodes.meterRight.fftSize);
  }

  function applyAudioSettings() {
    if (!audio.ctx || !audio.nodes) return;
    const n = audio.nodes;

    setParam(n.volumeGain.gain, Math.pow(10, settings.gainDB / 20));

    const profile = VOICE_PROFILES[settings.voicePreset];
    const scale = profile ? profile.gainScale : 0;
    for (let index = 0; index < n.eqFilters.length; index++) {
      setParam(n.eqFilters[index].gain, BILI_SPOKEN_WORD_GAINS[index] * scale);
    }

    const compressorData = profile || {
      threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25,
    };
    const now = audio.ctx.currentTime;
    const applyAt = now + 0.1;
    const compressorParams = ['threshold', 'knee', 'ratio', 'attack', 'release'];
    for (const key of compressorParams) {
      n.compressor[key].cancelScheduledValues(now);
      n.compressor[key].setValueAtTime(compressorData[key], applyAt);
    }

    applyBoostSettings();
    applyNormalizerSettings();
  }

  function energyToLUFS(energy) {
    return -0.691 + 10 * Math.log10(Math.max(energy, 1e-12));
  }

  function averageEnergy(blocks) {
    if (!blocks.length) return null;
    return blocks.reduce((sum, block) => sum + block.energy, 0) / blocks.length;
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function stabilizeDesiredGain(now, desiredGainDB, emergency) {
    if (emergency) {
      loudness.desiredTargets = [];
      return desiredGainDB;
    }
    loudness.desiredTargets.push({ at: now, gainDB: desiredGainDB });
    loudness.desiredTargets = loudness.desiredTargets
      .filter((sample) => now - sample.at <= NORMALIZER_CONFIG.targetWindowMs);
    const stableTarget = median(loudness.desiredTargets.map((sample) => sample.gainDB));
    if (desiredGainDB < loudness.currentGainDB - NORMALIZER_CONFIG.fastCutThresholdDB) {
      return Math.min(stableTarget ?? desiredGainDB, desiredGainDB);
    }
    return stableTarget ?? desiredGainDB;
  }

  function isGainDirectionReady(direction, now, emergency) {
    if (emergency || loudness.activeDirection === 0 || direction === loudness.activeDirection) {
      loudness.activeDirection = direction;
      loudness.pendingDirection = 0;
      loudness.pendingDirectionSince = 0;
      return true;
    }
    if (loudness.pendingDirection !== direction) {
      loudness.pendingDirection = direction;
      loudness.pendingDirectionSince = now;
      return false;
    }
    if (now - loudness.pendingDirectionSince < NORMALIZER_CONFIG.directionHoldMs) return false;
    loudness.activeDirection = direction;
    loudness.pendingDirection = 0;
    loudness.pendingDirectionSince = 0;
    return true;
  }

  function calculateWindowLUFS(now, windowMs, gated = false) {
    let blocks = loudness.blocks.filter((block) => now - block.at <= windowMs);
    if (gated) {
      blocks = blocks.filter((block) => block.lufs >= NORMALIZER_CONFIG.absoluteGateLUFS);
      const gatedEnergy = averageEnergy(blocks);
      if (gatedEnergy === null) return null;
      const relativeGate = Math.max(
        NORMALIZER_CONFIG.absoluteGateLUFS,
        energyToLUFS(gatedEnergy) - 10,
      );
      blocks = blocks.filter((block) => block.lufs >= relativeGate);
    }
    const energy = averageEnergy(blocks);
    return energy === null ? null : energyToLUFS(energy);
  }

  function resetLoudnessState(resetGain = true) {
    loudness.blocks = [];
    loudness.momentaryLUFS = null;
    loudness.shortTermLUFS = null;
    loudness.programLUFS = null;
    loudness.desiredTargets = [];
    loudness.startedAt = performance.now();
    loudness.lastTickAt = loudness.startedAt;
    loudness.boostCandidateSince = 0;
    loudness.lastSignalAt = loudness.startedAt;
    loudness.activeDirection = 0;
    loudness.pendingDirection = 0;
    loudness.pendingDirectionSince = 0;
    if (resetGain) {
      loudness.currentGainDB = 0;
      setAutoGainDB(0, 0.08);
    }
    syncNormalizerPanel();
  }

  function stopLoudnessMonitor() {
    if (!loudness.timer) return;
    clearInterval(loudness.timer);
    loudness.timer = null;
  }

  function startLoudnessMonitor() {
    if (loudness.timer) return;
    loudness.startedAt = performance.now();
    loudness.lastTickAt = loudness.startedAt;
    loudness.timer = setInterval(updateLoudnessNormalizer, NORMALIZER_CONFIG.updateMs);
  }

  function applyNormalizerSpeedPreset(preset) {
    const profile = NORMALIZER_SPEED_PROFILES[preset];
    if (!profile) return;
    const monitorWasRunning = Boolean(loudness.timer);
    if (monitorWasRunning) stopLoudnessMonitor();
    normalizerSpeedPreset = preset;
    Object.assign(NORMALIZER_CONFIG, profile);
    resetLoudnessState(false);
    if (monitorWasRunning) startLoudnessMonitor();
    syncStatusHud();
  }

  function setCompressorParams(node, values) {
    if (!audio.ctx || !node) return;
    const now = audio.ctx.currentTime;
    for (const [key, value] of Object.entries(values)) {
      node[key].cancelScheduledValues(now);
      node[key].setValueAtTime(value, now);
    }
  }

  function setLoudnessMeterConnected(enabled) {
    if (!audio.ctx || !audio.nodes || audio.nodes.meterConnected === enabled) return;
    const n = audio.nodes;
    if (enabled) {
      n.compressor.connect(n.meterShelf);
      n.meterShelf.connect(n.meterHighpass);
      n.meterHighpass.connect(n.meterSplitter);
      n.meterSplitter.connect(n.meterLeft, 0);
      n.meterSplitter.connect(n.meterRight, 1);
      n.meterLeft.connect(n.meterSink);
      n.meterRight.connect(n.meterSink);
      n.meterSink.connect(audio.ctx.destination);
    } else {
      try { n.compressor.disconnect(n.meterShelf); } catch (error) {}
      try { n.meterShelf.disconnect(); } catch (error) {}
      try { n.meterHighpass.disconnect(); } catch (error) {}
      try { n.meterSplitter.disconnect(); } catch (error) {}
      try { n.meterLeft.disconnect(); } catch (error) {}
      try { n.meterRight.disconnect(); } catch (error) {}
      try { n.meterSink.disconnect(); } catch (error) {}
    }
    n.meterConnected = enabled;
  }

  function getControlLoudness() {
    const shortTerm = loudness.shortTermLUFS;
    const program = loudness.programLUFS;
    if (shortTerm === null) return program;
    if (program === null) return shortTerm;
    return shortTerm * NORMALIZER_CONFIG.shortTermWeight
      + program * (1 - NORMALIZER_CONFIG.shortTermWeight);
  }

  function applyLimiterSettings() {
    if (!audio.ctx || !audio.nodes) return;
    const normalizerOn = settings.normalizerEnabled;
    const boostGuardOn = settings.boostPercent > BOOST_MIN_PERCENT && boostLimiterEnabled;
    const values = normalizerOn
      ? { threshold: -0.8, knee: 0, ratio: 20, attack: 0.001, release: 0.06 }
      : (boostGuardOn
        ? { threshold: -1, knee: 0, ratio: 12, attack: 0.003, release: 0.25 }
        : { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 });
    setCompressorParams(audio.nodes.limiter, values);
  }

  function applyBoostSettings() {
    if (!audio.ctx || !audio.nodes) return;
    setParam(audio.nodes.boostGain.gain, settings.boostPercent / BOOST_MIN_PERCENT, 0.02);
    applyLimiterSettings();
  }

  function applyNormalizerSettings() {
    if (!audio.ctx || !audio.nodes) return;
    const enabled = settings.normalizerEnabled;
    applyLimiterSettings();
    setLoudnessMeterConnected(enabled);

    if (enabled) {
      startLoudnessMonitor();
    } else {
      stopLoudnessMonitor();
      resetLoudnessState(true);
    }
  }

  function updateLoudnessNormalizer() {
    const n = audio.nodes;
    const video = audio.activeVideo;
    if (!settings.normalizerEnabled || !audio.ctx || !n || !video || video.paused
      || audio.ctx.state !== 'running' || !loudness.leftData || !loudness.rightData) return;

    n.meterLeft.getFloatTimeDomainData(loudness.leftData);
    n.meterRight.getFloatTimeDomainData(loudness.rightData);
    let sumSquares = 0;
    for (let index = 0; index < loudness.leftData.length; index++) {
      const left = loudness.leftData[index];
      const right = loudness.rightData[index];
      sumSquares += left * left + right * right;
    }

    const now = performance.now();
    const energy = sumSquares / loudness.leftData.length;
    const blockLUFS = energyToLUFS(energy);
    loudness.blocks.push({ at: now, energy, lufs: blockLUFS });
    loudness.blocks = loudness.blocks.filter((block) => now - block.at <= NORMALIZER_CONFIG.historyMs);
    loudness.momentaryLUFS = calculateWindowLUFS(now, NORMALIZER_CONFIG.momentaryMs);
    loudness.shortTermLUFS = calculateWindowLUFS(now, NORMALIZER_CONFIG.shortTermMs);
    loudness.programLUFS = calculateWindowLUFS(now, NORMALIZER_CONFIG.historyMs, true);

    const elapsed = now - loudness.startedAt;
    const measuredLUFS = getControlLoudness();
    if (elapsed >= NORMALIZER_CONFIG.warmupMs && measuredLUFS !== null) {
      const targetLUFS = LOUDNESS_PRESETS[settings.loudnessPreset] ?? LOUDNESS_PRESETS.standard;
      const momentaryLUFS = loudness.momentaryLUFS ?? measuredLUFS;
      const signalActive = momentaryLUFS >= NORMALIZER_CONFIG.boostGateLUFS
        || (loudness.shortTermLUFS ?? -120) >= NORMALIZER_CONFIG.boostGateLUFS;
      if (signalActive) loudness.lastSignalAt = now;

      let desiredGainDB = clamp(
        targetLUFS - measuredLUFS,
        NORMALIZER_CONFIG.maxCutDB,
        NORMALIZER_CONFIG.maxBoostDB,
      );
      if (momentaryLUFS > targetLUFS + NORMALIZER_CONFIG.emergencyMarginLU) {
        desiredGainDB = clamp(
          Math.min(
            desiredGainDB,
            targetLUFS + NORMALIZER_CONFIG.emergencyHeadroomLU - momentaryLUFS,
          ),
          NORMALIZER_CONFIG.maxCutDB,
          NORMALIZER_CONFIG.maxBoostDB,
        );
      }

      const emergency = momentaryLUFS > targetLUFS + NORMALIZER_CONFIG.emergencyMarginLU;
      const pauseExpired = !signalActive
        && now - loudness.lastSignalAt >= NORMALIZER_CONFIG.pauseHoldMs;
      if (pauseExpired && desiredGainDB > loudness.currentGainDB) {
        desiredGainDB = loudness.currentGainDB;
        loudness.desiredTargets = [];
      } else {
        desiredGainDB = stabilizeDesiredGain(now, desiredGainDB, emergency);
      }

      const boostingNoise = desiredGainDB > loudness.currentGainDB && !signalActive;
      const difference = desiredGainDB - loudness.currentGainDB;
      const targetAtLimit = desiredGainDB === NORMALIZER_CONFIG.maxBoostDB
        || desiredGainDB === NORMALIZER_CONFIG.maxCutDB;
      const activeDeadbandDB = targetAtLimit
        ? NORMALIZER_CONFIG.limitDeadbandDB
        : NORMALIZER_CONFIG.deadbandDB;
      const wantsBoost = difference >= activeDeadbandDB;
      if (!wantsBoost || boostingNoise) {
        loudness.boostCandidateSince = 0;
      } else if (!loudness.boostCandidateSince) {
        loudness.boostCandidateSince = now;
      }
      const boostReady = !wantsBoost
        || now - loudness.boostCandidateSince >= NORMALIZER_CONFIG.boostHoldMs;
      const direction = difference > 0 ? 1 : -1;
      const directionReady = Math.abs(difference) < activeDeadbandDB
        || isGainDirectionReady(direction, now, emergency);
      if (!boostingNoise && boostReady && directionReady
        && Math.abs(difference) >= activeDeadbandDB) {
        const deltaSeconds = clamp((now - loudness.lastTickAt) / 1000, 0.02, 0.25);
        const rate = difference < 0
          ? (emergency
            ? NORMALIZER_CONFIG.emergencyCutRateDBPerSecond
            : NORMALIZER_CONFIG.cutRateDBPerSecond)
          : NORMALIZER_CONFIG.boostRateDBPerSecond;
        const maxStep = rate * deltaSeconds;
        loudness.currentGainDB += clamp(difference, -maxStep, maxStep);
        setAutoGainDB(
          loudness.currentGainDB,
          difference < 0
            ? NORMALIZER_CONFIG.cutSmoothingSeconds
            : NORMALIZER_CONFIG.boostSmoothingSeconds,
        );
      } else if (Math.abs(difference) < activeDeadbandDB) {
        loudness.pendingDirection = 0;
        loudness.pendingDirectionSince = 0;
      }
    }

    loudness.lastTickAt = now;
    syncNormalizerPanel(false);
  }

  function setBoostPercent(percent, video = audio.activeVideo || findBestVideo()) {
    const next = clamp(Math.round(percent), BOOST_MIN_PERCENT, BOOST_MAX_PERCENT);
    if (next === settings.boostPercent) return;
    settings.boostPercent = next;
    if (next > BOOST_MIN_PERCENT) {
      const graphReady = Boolean(audio.ctx && audio.nodes && audio.activeSource
        && audio.activeVideo === video && audio.ctx.state === 'running');
      if (!graphReady && !ensureAudioForVideo(video)) {
        // 音频链路创建失败时回退，避免界面显示已增强但实际没生效
        settings.boostPercent = BOOST_MIN_PERCENT;
        applyBoostSettings();
        syncBoostReadout();
        return;
      }
    }
    applyBoostSettings();
    syncBoostReadout();
  }

  let volumeReadoutElement = null;
  let volumeReadoutSyncScheduled = false;

  function findVolumeControl(target) {
    const direct = target.closest(VOLUME_WHEEL_SELECTOR);
    if (direct) {
      // 面板/滑块可能是按钮的子节点，统一使用外层控件查找读数和所属视频。
      return direct.closest('.bpx-player-ctrl-volume, .bpx-player-rich-pip-volume, .bilibili-player-video-btn-volume')
        || direct;
    }
    // 兜底：B站改类名时，只要在播放器内且类名含 volume 也算音量控件
    const generic = target.closest('[class*="volume"]');
    if (generic && generic.closest(PLAYER_SELECTOR)) {
      return generic;
    }
    return null;
  }

  function findVolumeReadout(container) {
    if (volumeReadoutElement && volumeReadoutElement.isConnected
      && container.contains(volumeReadoutElement)) return volumeReadoutElement;
    const candidates = [];
    for (const element of container.querySelectorAll('*')) {
      if (element.childElementCount > 0) continue;
      if (!/^\d{1,4}$/.test((element.textContent || '').trim())) continue;
      candidates.push(element);
    }
    volumeReadoutElement = candidates[candidates.length - 1] || null;
    return volumeReadoutElement;
  }

  // B站音量面板的数字由它自己维护，永远停在 100；增强时改写它，让界面能看到实际倍率
  function syncVolumeReadout(container) {
    if (!container) return;
    const readout = findVolumeReadout(container);
    if (!readout) return;
    const video = findVideoForControl(container);
    const value = settings.boostPercent > BOOST_MIN_PERCENT
      ? settings.boostPercent
      : Math.round((video ? (video.muted ? 0 : video.volume) : 1) * 100);
    const text = String(value);
    if ((readout.textContent || '').trim() !== text) readout.textContent = text;
  }

  function scheduleVolumeReadoutSync(container) {
    if (volumeReadoutSyncScheduled) return;
    volumeReadoutSyncScheduled = true;
    requestAnimationFrame(() => {
      volumeReadoutSyncScheduled = false;
      syncVolumeReadout(container);
    });
  }

  // 仅在「网页全屏 / 全屏」下由脚本接管滚轮；普通、宽屏、小窗等模式交回 B站 原生滚轮逻辑。
  // 依次判断：原生全屏 API → 直播间模式类 → B站播放器 data-screen 属性 → 类名兜底 → 播放器是否铺满视口。
  function isImmersivePlayback(video, player) {
    if (document.fullscreenElement || document.webkitFullscreenElement
      || document.mozFullScreenElement || document.msFullscreenElement) return true;

    // 直播间：播放器根是 #live-player-ctnr，模式类标在它身上（normal=普通，其余按沉浸处理）
    const liveContainer = (video && video.closest && video.closest(LIVE_PLAYER_CONTAINER_SELECTOR))
      || (player && player.closest && player.closest(LIVE_PLAYER_CONTAINER_SELECTOR))
      || null;
    if (liveContainer) {
      const liveClassNames = String(liveContainer.className || '').split(/\s+/).filter(Boolean);
      if (liveClassNames.some((name) => LIVE_IMMERSIVE_CLASS_PATTERN.test(name))) return true;
      // 明确标了普通模式就不再往下猜（直播间的类名体系与 bpx 不同，兜底正则容易误判）
      if (liveClassNames.includes(LIVE_NORMAL_CLASS)) return false;
    }

    const container = (player && player.closest && player.closest('.bpx-player-container'))
      || (video && video.closest && video.closest('.bpx-player-container'))
      || null;
    const screen = container && container.getAttribute('data-screen');
    // data-screen: normal=普通, web=网页全屏, full=全屏, mini=小窗
    if (screen) return screen === 'web' || screen === 'full';

    // 兜底 1：B站改属性名时，用播放器/页面的类名判断
    const classHint = `${container ? container.className : ''} ${player ? player.className : ''}`
      + ` ${document.body ? document.body.className : ''}`;
    if (/webfull|web-full|fullscreen|screen-full/i.test(classHint)) return true;

    // 兜底 2：播放器铺满视口时视为沉浸模式（网页全屏/全屏都会铺满，宽屏模式高度不足）
    if (player && player.getBoundingClientRect) {
      const rect = player.getBoundingClientRect();
      if (rect.width >= window.innerWidth * 0.98 && rect.height >= window.innerHeight * 0.9) return true;
    }
    return false;
  }

  // 普通音量和增强音量都由脚本处理，滚轮与方向键共用同一套逻辑，只是档位不同。
  // direction：1 = 调大，-1 = 调小；stepPercent 为 100% 以内的每次调整幅度。
  function adjustPlayerVolume(video, direction, volumeControl, stepPercent = VOLUME_STEP_PERCENT) {
    const boosting = settings.boostPercent > BOOST_MIN_PERCENT;
    if (!video.muted && video.volume === 1 && (direction > 0 || boosting)) {
      // 已到 100%：继续调大进入增强区间，调小则先回到 100%
      setBoostPercent(direction > 0
        ? settings.boostPercent * BOOST_STEP_RATIO
        : settings.boostPercent / BOOST_STEP_RATIO, video);
    } else {
      // 静音按 0% 起步；在 0–100% 范围内每次固定增减 stepPercent。
      // 先清除残留增幅，再修改原生音量，避免恢复声音时突然放大。
      if (boosting) setBoostPercent(BOOST_MIN_PERCENT, video);
      const currentPercent = Math.round((video.muted ? 0 : video.volume) * 100);
      const nextPercent = clamp(currentPercent + direction * stepPercent, 0, 100);
      video.volume = nextPercent / 100;
      if (nextPercent > 0) video.muted = false;
    }
    if (volumeControl) lastVolumeControl = volumeControl;
    syncVolumeReadout(volumeControl);
    // 等播放器处理原生 volumechange 后再次同步数字。
    scheduleVolumeReadoutSync(volumeControl);
    // 全区域接管后统一显示提示，普通音量也能看到调整结果。
    showVolumeOsd(video);
  }

  function handleVolumeWheel(event) {
    // 滚轮调音量默认关闭，未在油猴菜单开启时完全交还浏览器原生滚轮行为
    if (!settings.wheelVolumeEnabled) return;
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0 || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const player = target.closest(PLAYER_SELECTOR);
    const directVolumeControl = findVolumeControl(target);
    // 只接管播放器内部；独立 video 元素也可以直接调节。
    if (!player && !directVolumeControl && !(target instanceof HTMLVideoElement)) return;
    const video = target instanceof HTMLVideoElement
      ? target
      : findVideoForControl(player || directVolumeControl, !player);
    if (!video) return;
    // 非网页全屏/全屏时不拦截事件，交由 B站 原生滚轮调音量逻辑处理
    if (!isImmersivePlayback(video, player)) return;
    const volumeControl = directVolumeControl || (player && player.querySelector(VOLUME_WHEEL_SELECTOR));

    resetSettingsForNewVideo();
    event.preventDefault();
    event.stopImmediatePropagation();
    adjustPlayerVolume(video, event.deltaY < 0 ? 1 : -1, volumeControl);
  }

  let lastVolumeKeyAt = 0;

  // 只在网页全屏/全屏下接管上下方向键调音量（每次 5%），普通模式交回 B站 原生逻辑。
  function handleVolumeKey(event) {
    if (!settings.wheelVolumeEnabled) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const direction = event.code === 'ArrowUp' ? 1 : (event.code === 'ArrowDown' ? -1 : 0);
    if (!direction) return;
    const target = event.target instanceof Element ? event.target : null;
    // 输入框/滑块获得焦点时交还原生按键行为（例如音量条本身的键盘操作）
    if (target && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    const video = findBestVideo();
    if (!video) return;
    const player = video.closest(PLAYER_SELECTOR);
    // 非网页全屏/全屏时不拦截按键，交由页面与 B站 原生逻辑处理
    if (!isImmersivePlayback(video, player)) return;

    const now = performance.now();
    if (event.repeat) {
      // 长按时限流，避免自动重复把音量（尤其是 >100% 的增强倍率）瞬间拉飞
      if (now - lastVolumeKeyAt < VOLUME_KEY_REPEAT_INTERVAL_MS) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
    lastVolumeKeyAt = now;

    resetSettingsForNewVideo();
    event.preventDefault();
    event.stopImmediatePropagation();
    const volumeControl = (player && player.querySelector(VOLUME_WHEEL_SELECTOR))
      || (lastVolumeControl && lastVolumeControl.isConnected ? lastVolumeControl : null);
    adjustPlayerVolume(video, direction, volumeControl, VOLUME_KEY_STEP_PERCENT);
  }

  function handleVolumeChange(event) {
    if (!(event.target instanceof HTMLVideoElement) || event.target !== audio.activeVideo) return;
    if (event.target.volume >= 0.999) return;
    // 用户把原生音量拉到 100% 以下时，滚轮增强归零
    if (settings.boostPercent > BOOST_MIN_PERCENT) setBoostPercent(BOOST_MIN_PERCENT);
  }

  function ensureAudioForVideo(video) {
    if (!video) {
      audio.error = '没有找到当前视频元素';
      return false;
    }

    try {
      buildAudioGraph();
      let source = audio.sources.get(video);
      if (!source) {
        source = audio.ctx.createMediaElementSource(video);
        audio.sources.set(video, source);
      }

      if (source !== audio.activeSource) {
        if (audio.activeSource) {
          try { audio.activeSource.disconnect(); } catch (error) {}
        }
        source.connect(audio.nodes.input);
        audio.activeSource = source;
        audio.activeVideo = video;
        resetLoudnessState(true);
      }

      applyAudioSettings();
      audio.ctx.resume().catch(() => {});
      audio.error = '';
      return true;
    } catch (error) {
      console.warn(`[${PREFIX}] 音频链路创建失败`, error);
      audio.error = error && error.name === 'InvalidStateError'
        ? '该视频已被其他音频脚本占用，请停用旧版音频脚本并刷新页面'
        : `音频处理启动失败：${error?.message ?? String(error)}`;
      return false;
    }
  }

  async function autoApplySavedEffect(video, allowPaused = false) {
    if (!(video instanceof HTMLVideoElement) || !hasSavedEffect() || autoApplyingVideos.has(video)) return;

    autoApplyingVideos.add(video);
    try {
      buildAudioGraph();
      if (audio.ctx.state !== 'running') {
        try { await audio.ctx.resume(); } catch (error) {}
      }

      if (audio.ctx.state !== 'running' || (!allowPaused && video.paused) || !video.isConnected) return;
      if (audio.activeVideo === video) applyAudioSettings();
      else ensureAudioForVideo(video);
    } catch (error) {
      console.warn(`[${PREFIX}] 已保存的音效自动恢复失败`, error);
    } finally {
      autoApplyingVideos.delete(video);
    }
  }

  function ensureStyles() {
    if (document.getElementById(`${PREFIX}-style`)) return;
    const style = document.createElement('style');
    style.id = `${PREFIX}-style`;
    style.textContent = `
      .${PREFIX}-panel-shell {
        position: fixed;
        display: none;
        width: min(310px, calc(100vw - 16px));
        z-index: 2147483647;
        box-sizing: border-box;
        overflow: hidden;
        color: #f1f2f3;
        background: rgba(28, 29, 33, .97);
        border: 1px solid rgba(255, 255, 255, .12);
        border-radius: 4px;
        box-shadow: 0 12px 34px rgba(0, 0, 0, .5);
        font: 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        user-select: none;
        opacity: 0;
        transform: translateY(8px) scale(.96);
        transform-origin: center;
        transition: opacity .16s ease, transform .18s cubic-bezier(.2, .8, .2, 1);
      }
      .${PREFIX}-panel-shell.fx-open {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      .${PREFIX}-panel-shell * { box-sizing: border-box; }
      .${PREFIX}-panel-shell .fx-header {
        display: flex;
        align-items: center;
        min-height: 46px;
        padding: 0 12px 0 14px;
        border-bottom: 1px solid rgba(255, 255, 255, .12);
      }
      .${PREFIX}-panel-shell .fx-title {
        flex: 1;
        min-width: 0;
        font-size: 15px;
        font-weight: 600;
      }
      .${PREFIX}-panel-shell button { font: inherit; }
      .${PREFIX}-panel-shell .fx-reset,
      .${PREFIX}-panel-shell .fx-close {
        border: 0;
        background: transparent;
        cursor: pointer;
      }
      .${PREFIX}-panel-shell .fx-reset {
        padding: 4px 7px;
        color: #00aeec;
        font-size: 12px;
      }
      .${PREFIX}-panel-shell .fx-close {
        width: 28px;
        height: 28px;
        padding: 0;
        color: #d9d9d9;
        font-size: 23px;
        line-height: 24px;
      }
      .${PREFIX}-panel-shell .fx-body { padding: 14px; }
      .${PREFIX}-panel-shell .fx-control-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 24px;
        margin-bottom: 8px;
      }
      .${PREFIX}-panel-shell .fx-value {
        color: #00aeec;
        font-variant-numeric: tabular-nums;
      }
      .${PREFIX}-panel-shell button.fx-boost-value {
        padding: 0;
        border: 0;
        background: transparent;
        font: inherit;
        cursor: pointer;
      }
      .${PREFIX}-panel-shell .fx-divider {
        height: 1px;
        margin: 14px 0;
        background: rgba(255, 255, 255, .12);
      }
      .${PREFIX}-panel-shell .fx-range {
        --fill: 50%;
        display: block;
        width: 100%;
        height: 16px;
        margin: 0;
        appearance: none;
        -webkit-appearance: none;
        background: transparent;
        cursor: pointer;
      }
      .${PREFIX}-panel-shell .fx-range::-webkit-slider-runnable-track {
        height: 4px;
        border-radius: 2px;
        background: linear-gradient(to right, #00aeec 0 var(--fill), #686b70 var(--fill) 100%);
      }
      .${PREFIX}-panel-shell .fx-range::-webkit-slider-thumb {
        width: 16px;
        height: 16px;
        margin-top: -6px;
        appearance: none;
        -webkit-appearance: none;
        border: 0;
        border-radius: 50%;
        background: #00aeec;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, .25);
      }
      .${PREFIX}-panel-shell .fx-range::-moz-range-track {
        height: 4px;
        border-radius: 2px;
        background: #686b70;
      }
      .${PREFIX}-panel-shell .fx-range::-moz-range-progress { height: 4px; background: #00aeec; }
      .${PREFIX}-panel-shell .fx-range::-moz-range-thumb {
        width: 16px;
        height: 16px;
        border: 0;
        border-radius: 50%;
        background: #00aeec;
      }
      .${PREFIX}-panel-shell .fx-voice-label { margin-bottom: 9px; }
      .${PREFIX}-panel-shell .fx-segments {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        height: 32px;
        padding: 2px;
        gap: 2px;
        background: #3d3f43;
        border-radius: 4px;
      }
      .${PREFIX}-panel-shell .fx-segment {
        min-width: 0;
        padding: 0 4px;
        overflow: hidden;
        color: #c9ccd0;
        white-space: nowrap;
        text-overflow: ellipsis;
        background: transparent;
        border: 0;
        border-radius: 3px;
        cursor: pointer;
        transition: color .15s ease, background .15s ease;
      }
      .${PREFIX}-panel-shell .fx-segment:hover { color: #fff; background: #53565b; }
      .${PREFIX}-panel-shell .fx-segment.active { color: #fff; background: #00aeec; }
      .${PREFIX}-panel-shell .fx-error {
        display: none;
        margin-top: 12px;
        padding: 8px 10px;
        color: #ffb3b3;
        background: rgba(244, 63, 63, .14);
        border: 1px solid rgba(244, 63, 63, .3);
        border-radius: 3px;
        font-size: 12px;
        user-select: text;
      }
      .${PREFIX}-normalizer-switch {
        position: relative;
        width: 38px;
        height: 22px;
        padding: 0;
        border: 0;
        border-radius: 11px;
        background: #5d6065;
        cursor: pointer;
        transition: background .16s ease;
      }
      .${PREFIX}-normalizer-switch::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #fff;
        transition: transform .16s ease;
      }
      .${PREFIX}-normalizer-switch.active { background: #00aeec; }
      .${PREFIX}-normalizer-switch.active::after { transform: translateX(16px); }
      .${PREFIX}-normalizer-status {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 12px;
      }
      #${PREFIX}-normalizer-panel .fx-segments {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      #${PREFIX}-normalizer-panel .fx-speed-segments {
        grid-template-columns: repeat(5, minmax(0, 1fr));
      }
      #${PREFIX}-normalizer-panel .fx-speed-segments .fx-segment {
        padding: 0 2px;
        font-size: 12px;
      }
      .${PREFIX}-normalizer-stat {
        padding: 8px 9px;
        color: #aeb2b7;
        background: #24262a;
        border-radius: 4px;
        font-size: 12px;
      }
      .${PREFIX}-normalizer-stat strong {
        display: block;
        margin-top: 3px;
        color: #f1f2f3;
        font-size: 14px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }
      .${PREFIX}-toolbar {
        position: relative;
        padding: 0 !important;
        color: rgba(255, 255, 255, .9);
        background: transparent !important;
        border: 0;
        outline: 0;
        cursor: pointer;
        box-sizing: border-box;
        transition: color .15s ease, opacity .15s ease;
      }
      .${PREFIX}-toolbar:not(.bpx-player-ctrl-btn):not(.bilibili-player-video-btn) {
        display: inline-flex !important;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 22px;
        line-height: 22px;
      }
      .${PREFIX}-toolbar:hover,
      .${PREFIX}-toolbar:focus-visible { color: #fff; }
      .${PREFIX}-toolbar:focus-visible { outline: 1px solid rgba(0, 174, 236, .9); outline-offset: -3px; }
      .${PREFIX}-toolbar.fx-panel-open { color: #00aeec; }
      .${PREFIX}-toolbar .bpx-player-ctrl-btn-icon {
        cursor: pointer;
      }
      .${PREFIX}-toolbar .bpx-common-svg-icon {
        position: relative;
      }
      .${PREFIX}-toolbar:not(.bpx-player-ctrl-btn):not(.bilibili-player-video-btn) .bpx-player-ctrl-btn-icon {
        display: block;
        width: 100%;
      }
      .${PREFIX}-toolbar:not(.bpx-player-ctrl-btn):not(.bilibili-player-video-btn) .bpx-common-svg-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        vertical-align: middle;
      }
      .${PREFIX}-toolbar-icon {
        display: block;
        width: auto;
        height: calc(100% - 4px);
        aspect-ratio: 1;
        pointer-events: none;
      }
      .${PREFIX}-toolbar.fx-feature-enabled .bpx-common-svg-icon::after {
        content: "";
        position: absolute;
        right: 0;
        bottom: 1px;
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background: #00aeec;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, .45);
      }
      /* 直播间：按钮插在控制栏（.web-player-controller-bg）内部，垂直居中；
         水平位置由 layoutLiveToolbar() 在运行时排在原生控件右侧（原生控件靠左排列，右侧是空的）。
         控制栏隐藏时自身 display:none / visibility:hidden，按钮作为子节点自动跟着隐藏。 */
      .${PREFIX}-live-toolbar {
        position: absolute;
        top: 50%;
        z-index: 14;
        display: flex !important;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 32px;
        border-radius: 4px;
        color: rgba(255, 255, 255, .9);
        transform: translateY(-50%);
      }
      .${PREFIX}-live-toolbar-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
      }
      .${PREFIX}-live-toolbar-svg { display: block; width: 100%; height: 100%; }
      .${PREFIX}-live-toolbar-svg > .${PREFIX}-toolbar-icon { height: 100%; }
      .${PREFIX}-toolbar.fx-feature-enabled .${PREFIX}-live-toolbar-svg::after {
        content: "";
        position: absolute;
        right: 0;
        bottom: 1px;
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background: #00aeec;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, .45);
      }
      .${PREFIX}-status-hud {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 2147483646;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        width: min(224px, calc(100vw - 16px));
        padding: 7px 9px;
        overflow: hidden;
        color: #e7e9eb;
        background: rgba(24, 25, 28, var(--status-bg-opacity, .45));
        border: 1px solid rgba(255, 255, 255, .14);
        border-radius: 4px;
        box-shadow: 0 5px 16px rgba(0, 0, 0, .32);
        box-sizing: border-box;
        font: 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0;
        white-space: nowrap;
        pointer-events: none;
        user-select: none;
        opacity: 0;
        visibility: hidden;
        transform: translateX(-5px);
        transition: opacity .14s ease, transform .14s ease, visibility 0s linear .14s;
      }
      .${PREFIX}-status-hud.fx-visible {
        opacity: 1;
        visibility: visible;
        transform: translateX(0);
        transition-delay: 0s;
      }
      .${PREFIX}-status-segment {
        display: none;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        min-height: 24px;
        min-width: 0;
        gap: 8px;
      }
      .${PREFIX}-status-segment.fx-active { display: flex; }
      .${PREFIX}-status-segment.fx-divider {
        margin-top: 4px;
        padding-top: 4px;
        border-top: 1px solid rgba(255, 255, 255, .14);
      }
      .${PREFIX}-status-name { color: #fff; font-weight: 600; }
      .${PREFIX}-status-name .fx-response-speed { color: #8edcf5; font-weight: 500; }
      .${PREFIX}-status-value { color: #c9ccd0; }
      .${PREFIX}-status-gain { color: #67d2f4; }
      .${PREFIX}-status-segment.fx-dynamic {
        flex-direction: column;
        align-items: stretch;
        min-height: 39px;
        gap: 5px;
      }
      .${PREFIX}-status-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-width: 0;
        gap: 8px;
      }
      .${PREFIX}-status-detail { color: #c9ccd0; }
      .${PREFIX}-status-meter {
        position: relative;
        flex: 1;
        min-width: 64px;
        height: 4px;
        overflow: visible;
        background: rgba(255, 255, 255, .2);
        border-radius: 2px;
      }
      .${PREFIX}-status-meter::after {
        content: "";
        position: absolute;
        left: 50%;
        top: -2px;
        width: 1px;
        height: 8px;
        background: rgba(255, 255, 255, .72);
      }
      .${PREFIX}-status-meter-fill {
        position: absolute;
        top: 0;
        left: 50%;
        width: 0;
        height: 100%;
        border-radius: 2px;
        background: #67d2f4;
      }
      .${PREFIX}-status-meter-fill.fx-cut { background: #f3b45a; }
      .${PREFIX}-status-meter-marker {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, .5);
        transform: translate(-50%, -50%);
      }
      .${PREFIX}-volume-osd {
        position: fixed;
        z-index: 2147483647;
        display: none;
        align-items: center;
        gap: 12px;
        box-sizing: border-box;
        padding: 16px 22px;
        border-radius: 8px;
        background: rgba(0, 0, 0, .65);
        color: #fff;
        font: 500 24px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        pointer-events: none;
        user-select: none;
        transform: translate(-50%, -50%);
      }
      .${PREFIX}-volume-osd svg { width: 30px; height: 30px; flex-shrink: 0; }
      @media (max-width: 600px) {
        .${PREFIX}-status-hud { width: min(204px, calc(100vw - 16px)); padding: 6px 8px; font-size: 11px; }
        .${PREFIX}-status-segment { gap: 6px; }
        .${PREFIX}-status-row { gap: 6px; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function formatSignedDB(value) {
    const normalized = Math.abs(value) < 0.05 ? 0 : value;
    return `${normalized > 0 ? '+' : ''}${normalized.toFixed(1)} dB`;
  }

  function ensureStatusHud() {
    if (statusHud && statusHud.isConnected) return;
    ensureStyles();
    statusHud = document.createElement('div');
    statusHud.className = `${PREFIX}-status-hud`;
    statusHud.style.setProperty('--status-bg-opacity', String(statusHudOpacity));
    statusHud.setAttribute('role', 'status');
    statusHud.setAttribute('aria-live', 'off');
    statusHud.innerHTML = `
      <span class="${PREFIX}-status-segment fx-dynamic">
        <span class="${PREFIX}-status-row">
          <strong class="${PREFIX}-status-name">动态音量 <span class="fx-response-speed">· 均衡</span></strong>
          <span class="${PREFIX}-status-gain fx-current-compensation">补偿 0.0 dB</span>
        </span>
        <span class="${PREFIX}-status-row ${PREFIX}-status-detail">
          <span class="${PREFIX}-status-value fx-current-loudness">当前 --</span>
          <span class="${PREFIX}-status-meter" aria-hidden="true">
            <span class="${PREFIX}-status-meter-fill"></span>
            <span class="${PREFIX}-status-meter-marker"></span>
          </span>
        </span>
      </span>
      <span class="${PREFIX}-status-segment fx-manual-gain">
        <strong class="${PREFIX}-status-name">音量增强</strong>
        <span class="${PREFIX}-status-gain fx-manual-gain-value">0.0 dB</span>
      </span>
      <span class="${PREFIX}-status-segment fx-voice">
        <strong class="${PREFIX}-status-name">清澈人声</strong>
        <span class="${PREFIX}-status-value fx-voice-value">关闭</span>
      </span>
    `;
    statusRefs = {
      dynamic: statusHud.querySelector('.fx-dynamic'),
      responseSpeed: statusHud.querySelector('.fx-response-speed'),
      loudness: statusHud.querySelector('.fx-current-loudness'),
      compensation: statusHud.querySelector('.fx-current-compensation'),
      meterFill: statusHud.querySelector(`.${PREFIX}-status-meter-fill`),
      meterMarker: statusHud.querySelector(`.${PREFIX}-status-meter-marker`),
      manualGain: statusHud.querySelector('.fx-manual-gain'),
      manualGainValue: statusHud.querySelector('.fx-manual-gain-value'),
      voice: statusHud.querySelector('.fx-voice'),
      voiceValue: statusHud.querySelector('.fx-voice-value'),
    };
    (document.body || document.documentElement).appendChild(statusHud);
    statusHudMetrics.width = -1;
    statusHudMetrics.height = -1;
    statusHudMetrics.segments = -1;
    statusHudMetrics.left = '';
    statusHudMetrics.top = '';
  }

  function isStatusControlVisible(video) {
    if (!video) return false;
    const player = video.closest(PLAYER_SELECTOR);
    const root = player || document;
    const selector = [
      `[data-${PREFIX}-toolbar="1"]`,
      `[data-${PREFIX}-normalizer-toolbar="1"]`,
    ].join(',');
    const videoRect = video.getBoundingClientRect();

    for (const button of root.querySelectorAll(selector)) {
      if (!button.isConnected) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4 || rect.right <= videoRect.left
        || rect.left >= videoRect.right || rect.bottom <= videoRect.top
        || rect.top >= videoRect.bottom) continue;

      let visible = true;
      for (let node = button; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        const opacity = Number.parseFloat(style.opacity);
        if (style.display === 'none' || style.visibility === 'hidden'
          || (Number.isFinite(opacity) && opacity <= 0.05)) {
          visible = false;
          break;
        }
        if (node === player) break;
      }
      if (visible) return true;
    }
    return false;
  }

  function hideStatusHud() {
    if (statusHud) statusHud.classList.remove('fx-visible');
  }

  function syncStatusHud() {
    // 标签页在后台时不可见，跳过这一轮（含 isStatusControlVisible 的强制样式重算），恢复可见后下一轮会自动重建
    if (document.hidden) {
      hideStatusHud();
      return;
    }
    if (!statusHudEnabled) {
      hideStatusHud();
      return;
    }
    const dynamicActive = settings.normalizerEnabled;
    const boostActive = settings.boostPercent > BOOST_MIN_PERCENT;
    const manualGainActive = Math.abs(settings.gainDB) >= 0.05 || boostActive;
    const voiceActive = settings.voicePreset !== 'off';
    if (!dynamicActive && !manualGainActive && !voiceActive) {
      displayedLoudness = null;
      displayedNormalizerGain = 0;
      hideStatusHud();
      return;
    }

    ensureStatusHud();
    const segments = [
      [statusRefs.dynamic, dynamicActive],
      [statusRefs.manualGain, manualGainActive],
      [statusRefs.voice, voiceActive],
    ];
    let visibleSegmentCount = 0;
    for (const [segment, active] of segments) {
      segment.classList.toggle('fx-active', active);
      segment.classList.toggle('fx-divider', active && visibleSegmentCount > 0);
      if (active) visibleSegmentCount++;
    }

    if (dynamicActive) {
      const speedNames = {
        rapid: '极速', fast: '快速', balanced: '均衡', gentle: '平缓', slow: '慢速',
      };
      statusRefs.responseSpeed.textContent = `· ${speedNames[normalizerSpeedPreset] || '均衡'}`;
      const measured = getControlLoudness();
      if (measured === null) {
        displayedLoudness = null;
      } else {
        displayedLoudness = displayedLoudness === null
          ? measured
          : displayedLoudness + (measured - displayedLoudness) * 0.45;
      }
      displayedNormalizerGain += (loudness.currentGainDB - displayedNormalizerGain) * 0.55;
      if (Math.abs(loudness.currentGainDB - displayedNormalizerGain) < 0.03) {
        displayedNormalizerGain = loudness.currentGainDB;
      }

      statusRefs.loudness.textContent = displayedLoudness === null
        ? '当前 --'
        : `当前 ${displayedLoudness.toFixed(1)} LUFS`;
      statusRefs.compensation.textContent = `补偿 ${formatSignedDB(displayedNormalizerGain)}`;
      const meterMinDB = NORMALIZER_CONFIG.maxCutDB;
      const meterMaxDB = NORMALIZER_CONFIG.maxBoostDB;
      const markerPercent = ((clamp(displayedNormalizerGain, meterMinDB, meterMaxDB) - meterMinDB)
        / (meterMaxDB - meterMinDB)) * 100;
      statusRefs.meterMarker.style.left = `${markerPercent}%`;
      statusRefs.meterFill.style.left = `${Math.min(50, markerPercent)}%`;
      statusRefs.meterFill.style.width = `${Math.abs(markerPercent - 50)}%`;
      statusRefs.meterFill.classList.toggle('fx-cut', displayedNormalizerGain < -0.05);
    } else {
      displayedLoudness = null;
      displayedNormalizerGain = 0;
    }

    if (manualGainActive) {
      const parts = [];
      if (Math.abs(settings.gainDB) >= 0.05) parts.push(formatSignedDB(settings.gainDB));
      if (boostActive) parts.push(`${settings.boostPercent}%`);
      statusRefs.manualGainValue.textContent = parts.join(' · ');
    }
    if (voiceActive) {
      const voiceNames = { a: 'A 轻柔', b: 'B 原生', c: 'C 强化' };
      statusRefs.voiceValue.textContent = voiceNames[settings.voicePreset] || settings.voicePreset.toUpperCase();
    }

    const video = findBestVideo();
    const videoRect = getPlayerRect(video);
    if (!videoRect || !isStatusControlVisible(video)) {
      hideStatusHud();
      return;
    }

    const host = document.fullscreenElement || document.webkitFullscreenElement
      || document.body || document.documentElement;
    if (statusHud.parentElement !== host) host.appendChild(statusHud);

    const nextWidth = Math.max(80, Math.min(224, videoRect.width - 24));
    if (statusHudMetrics.width !== nextWidth || statusHudMetrics.segments !== visibleSegmentCount) {
      statusHud.style.width = `${nextWidth}px`;
      statusHudMetrics.width = nextWidth;
      statusHudMetrics.segments = visibleSegmentCount;
      statusHudMetrics.height = -1;
    }
    if (statusHudMetrics.height < 0) {
      statusHudMetrics.height = statusHud.offsetHeight;
      statusHudMetrics.renderedWidth = statusHud.offsetWidth;
    }
    const width = statusHudMetrics.renderedWidth;
    const height = statusHudMetrics.height;
    const viewportMaxLeft = Math.max(8, window.innerWidth - width - 8);
    const viewportMaxTop = Math.max(8, window.innerHeight - height - 8);
    const playerMaxLeft = Math.min(viewportMaxLeft, videoRect.right - width - 12);
    const playerMaxTop = Math.min(viewportMaxTop, videoRect.bottom - height - 12);
    const left = `${clamp(videoRect.left + 12, 8, Math.max(8, playerMaxLeft))}px`;
    const top = `${clamp(videoRect.top + 12, 8, Math.max(8, playerMaxTop))}px`;
    if (statusHudMetrics.left !== left) {
      statusHud.style.left = left;
      statusHudMetrics.left = left;
    }
    if (statusHudMetrics.top !== top) {
      statusHud.style.top = top;
      statusHudMetrics.top = top;
    }
    statusHud.classList.add('fx-visible');
  }

  function paintRange(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    input.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
  }

  function ensurePanel() {
    if (panel && panel.isConnected) return;
    ensureStyles();
    panel = document.createElement('div');
    panel.id = `${PREFIX}-panel`;
    panel.className = `${PREFIX}-panel-shell`;
    panel.tabIndex = -1;
    panel.innerHTML = `
      <div class="fx-header">
        <div class="fx-title">音频增强</div>
        <button type="button" class="fx-reset">恢复默认</button>
        <button type="button" class="fx-close" title="关闭" aria-label="关闭">×</button>
      </div>
      <div class="fx-body">
        <div class="fx-control-row">
          <span>音量增强</span>
          <span class="fx-value">0.0 dB</span>
        </div>
        <input class="fx-range" type="range" min="-12" max="12" step="0.5" value="0">
        <div class="fx-control-row">
          <span>滚轮增强</span>
          <button type="button" class="fx-value fx-boost-value" title="点击重置为 100%">100%</button>
        </div>
        <div class="fx-divider"></div>
        <div class="fx-voice-label">清澈人声</div>
        <div class="fx-segments" role="group" aria-label="清澈人声预设">
          <button type="button" class="fx-segment" data-voice="off">关闭</button>
          <button type="button" class="fx-segment" data-voice="a" title="轻柔：原生清澈人声的较弱版本">A 轻柔</button>
          <button type="button" class="fx-segment" data-voice="b" title="原生：逐参数复刻B站清澈人声">B 原生</button>
          <button type="button" class="fx-segment" data-voice="c" title="强化：在原生基础上进一步突出人声">C 强化</button>
        </div>
        <div class="fx-error"></div>
      </div>
    `;

    panelRefs = {
      reset: panel.querySelector('.fx-reset'),
      close: panel.querySelector('.fx-close'),
      gain: panel.querySelector('.fx-range'),
      gainValue: panel.querySelector('.fx-value:not(.fx-boost-value)'),
      boostValue: panel.querySelector('.fx-boost-value'),
      voiceButtons: [...panel.querySelectorAll('.fx-segment')],
      error: panel.querySelector('.fx-error'),
    };

    panelRefs.gain.addEventListener('input', () => {
      settings.gainDB = Number(panelRefs.gain.value);
      applyPanelAudioSettings();
      syncPanel();
    });

    for (const button of panelRefs.voiceButtons) {
      button.addEventListener('click', () => {
        settings.voicePreset = button.dataset.voice;
        applyPanelAudioSettings();
        syncPanel();
      });
    }

    panelRefs.reset.addEventListener('click', () => {
      settings.gainDB = DEFAULT_SETTINGS.gainDB;
      settings.voicePreset = DEFAULT_SETTINGS.voicePreset;
      applyPanelAudioSettings();
      syncPanel();
    });

    panelRefs.boostValue.addEventListener('click', () => setBoostPercent(BOOST_MIN_PERCENT));
    panelRefs.close.addEventListener('click', closePanel);
    panel.addEventListener('contextmenu', (event) => event.preventDefault());
    (document.body || document.documentElement).appendChild(panel);
  }

  let volumeOsd = null;
  let volumeOsdValue = null;
  let volumeOsdTimer = null;

  function hideVolumeOsd() {
    if (volumeOsdTimer !== null) clearTimeout(volumeOsdTimer);
    volumeOsdTimer = null;
    if (volumeOsd) volumeOsd.style.display = 'none';
  }

  function showVolumeOsd(video) {
    hideVolumeOsd();
    const rect = getPlayerRect(video);
    if (!rect) return;
    ensureStyles();
    if (!volumeOsd) {
      volumeOsd = document.createElement('div');
      volumeOsd.className = `${PREFIX}-volume-osd`;
      volumeOsd.setAttribute('aria-hidden', 'true');
      volumeOsd.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M11 5 6 9H3v6h3l5 4Z"/>
        <path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>
      </svg>`;
      volumeOsdValue = document.createElement('span');
      volumeOsd.appendChild(volumeOsdValue);
    }
    const host = document.fullscreenElement || document.webkitFullscreenElement
      || document.body || document.documentElement;
    if (volumeOsd.parentElement !== host) host.appendChild(volumeOsd);
    const percent = video.muted ? 0 : Math.round(video.volume * settings.boostPercent);
    volumeOsdValue.textContent = `${percent}%`;
    volumeOsd.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    volumeOsd.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
    volumeOsd.style.display = 'flex';
    volumeOsdTimer = setTimeout(hideVolumeOsd, 1000);
  }

  let lastVolumeControl = null;

  function syncBoostReadout() {
    if (panelRefs.boostValue) panelRefs.boostValue.textContent = `${settings.boostPercent}%`;
  }

  function syncPanel() {
    syncToolbarButtons();
    if (!panel) return;
    panelRefs.gain.value = settings.gainDB;
    panelRefs.gainValue.textContent = formatSignedDB(settings.gainDB);
    for (const button of panelRefs.voiceButtons) {
      button.classList.toggle('active', button.dataset.voice === settings.voicePreset);
    }
    paintRange(panelRefs.gain);
    syncBoostReadout();
    panelRefs.error.textContent = audio.error;
    panelRefs.error.style.display = audio.error ? 'block' : 'none';
  }

  function getPlayerRect(video) {
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function applyPanelAudioSettings() {
    const video = panelVideo && panelVideo.isConnected ? panelVideo : findBestVideo();
    if (hasSavedEffect()) ensureAudioForVideo(video);
    else applyAudioSettings();
  }

  function openFloatingPanel(target, video) {
    const host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (host && target.parentElement !== host) host.appendChild(target);

    target.classList.remove('fx-open');
    target.style.display = 'block';
    target.style.visibility = 'hidden';
    target.style.left = '0px';
    target.style.top = '0px';

    const width = target.offsetWidth;
    const height = target.offsetHeight;
    const playerRect = getPlayerRect(video);
    const desiredLeft = playerRect ? playerRect.left + (playerRect.width - width) / 2 : (window.innerWidth - width) / 2;
    const desiredTop = playerRect ? playerRect.top + (playerRect.height - height) / 2 : (window.innerHeight - height) / 2;

    target.style.left = `${clamp(desiredLeft, 8, Math.max(8, window.innerWidth - width - 8))}px`;
    target.style.top = `${clamp(desiredTop, 8, Math.max(8, window.innerHeight - height - 8))}px`;
    target.style.visibility = 'visible';
    void target.offsetWidth;
    requestAnimationFrame(() => {
      target.classList.add('fx-open');
      syncToolbarButtons();
    });
    target.focus({ preventScroll: true });
    return performance.now();
  }

  function closeFloatingPanel(target, currentTimer) {
    if (!target || target.style.display === 'none') return currentTimer;
    target.classList.remove('fx-open');
    syncToolbarButtons();
    if (currentTimer) clearTimeout(currentTimer);
    return setTimeout(() => {
      if (target) target.style.display = 'none';
    }, 180);
  }

  function showPanel(video) {
    resetSettingsForNewVideo();
    closeNormalizerPanel();
    ensurePanel();
    panelVideo = video;
    if (hasSavedEffect()) ensureAudioForVideo(video);
    syncPanel();

    if (panelCloseTimer) {
      clearTimeout(panelCloseTimer);
      panelCloseTimer = null;
    }
    panelOpenedAt = openFloatingPanel(panel, video);
  }

  function closePanel() {
    panelCloseTimer = closeFloatingPanel(panel, panelCloseTimer);
  }

  function ensureNormalizerPanel() {
    if (normalizerPanel && normalizerPanel.isConnected) return;
    ensureStyles();
    normalizerPanel = document.createElement('div');
    normalizerPanel.id = `${PREFIX}-normalizer-panel`;
    normalizerPanel.className = `${PREFIX}-panel-shell`;
    normalizerPanel.tabIndex = -1;
    normalizerPanel.innerHTML = `
      <div class="fx-header">
        <div class="fx-title">动态音量</div>
        <button type="button" class="fx-close" title="关闭" aria-label="关闭">×</button>
      </div>
      <div class="fx-body">
        <div class="fx-control-row">
          <span>响度平衡</span>
          <button type="button" class="${PREFIX}-normalizer-switch" role="switch" aria-checked="false"></button>
        </div>
        <div class="fx-divider"></div>
        <div class="fx-voice-label">目标响度</div>
        <div class="fx-segments" role="group" aria-label="目标响度">
          <button type="button" class="fx-segment" data-loudness="comfortable" title="目标 -16 LUFS">舒适</button>
          <button type="button" class="fx-segment" data-loudness="standard" title="目标 -14 LUFS">标准</button>
          <button type="button" class="fx-segment" data-loudness="loud" title="目标 -12 LUFS">响亮</button>
        </div>
        <div class="fx-divider"></div>
        <div class="fx-voice-label">响应速度</div>
        <div class="fx-segments fx-speed-segments" role="group" aria-label="动态音量响应速度">
          <button type="button" class="fx-segment" data-speed="rapid" title="多人游戏语音，发言者频繁切换">极速</button>
          <button type="button" class="fx-segment" data-speed="fast" title="多人对话、直播连麦">快速</button>
          <button type="button" class="fx-segment" data-speed="balanced" title="单人讲话，偶尔远近变化">均衡</button>
          <button type="button" class="fx-segment" data-speed="gentle" title="教程录制、访谈">平缓</button>
          <button type="button" class="fx-segment" data-speed="slow" title="音量整体稳定，尽量减少抽吸感">慢速</button>
        </div>
        <div class="${PREFIX}-normalizer-status">
          <div class="${PREFIX}-normalizer-stat">当前响度<strong class="fx-loudness-value">-- LUFS</strong></div>
          <div class="${PREFIX}-normalizer-stat">动态补偿<strong class="fx-normalizer-gain">0.0 dB</strong></div>
        </div>
        <div class="fx-error"></div>
      </div>
    `;

    normalizerRefs = {
      close: normalizerPanel.querySelector('.fx-close'),
      toggle: normalizerPanel.querySelector(`.${PREFIX}-normalizer-switch`),
      presetButtons: [...normalizerPanel.querySelectorAll('[data-loudness]')],
      speedButtons: [...normalizerPanel.querySelectorAll('[data-speed]')],
      loudnessValue: normalizerPanel.querySelector('.fx-loudness-value'),
      gainValue: normalizerPanel.querySelector('.fx-normalizer-gain'),
      error: normalizerPanel.querySelector('.fx-error'),
    };

    normalizerRefs.toggle.addEventListener('click', () => {
      settings.normalizerEnabled = !settings.normalizerEnabled;
      const video = findBestVideo();
      if (settings.normalizerEnabled) {
        resetLoudnessState(true);
        if (!ensureAudioForVideo(video)) {
          settings.normalizerEnabled = false;
          applyAudioSettings();
        }
      } else {
        applyAudioSettings();
      }
      syncNormalizerPanel();
    });

    for (const button of normalizerRefs.presetButtons) {
      button.addEventListener('click', () => {
        settings.loudnessPreset = button.dataset.loudness;
        syncNormalizerPanel();
      });
    }

    for (const button of normalizerRefs.speedButtons) {
      button.addEventListener('click', () => {
        const preset = button.dataset.speed;
        applyNormalizerSpeedPreset(preset);
        saveNormalizerSpeedPreset(preset);
        registerNormalizerSpeedMenu();
        syncNormalizerPanel();
      });
    }

    normalizerRefs.close.addEventListener('click', closeNormalizerPanel);
    normalizerPanel.addEventListener('contextmenu', (event) => event.preventDefault());
    (document.body || document.documentElement).appendChild(normalizerPanel);
  }

  function syncNormalizerPanel(updateToolbar = true) {
    if (updateToolbar) syncToolbarButtons();
    if (!normalizerPanel) return;
    // 面板未展开时跳过数值刷新，避免每个监测 tick 都写隐藏 DOM
    const readoutVisible = normalizerPanel.style.display !== 'none';
    normalizerRefs.toggle.classList.toggle('active', settings.normalizerEnabled);
    normalizerRefs.toggle.setAttribute('aria-checked', String(settings.normalizerEnabled));
    normalizerRefs.toggle.title = settings.normalizerEnabled ? '关闭动态音量' : '开启动态音量';
    for (const button of normalizerRefs.presetButtons) {
      button.classList.toggle('active', button.dataset.loudness === settings.loudnessPreset);
    }
    for (const button of normalizerRefs.speedButtons) {
      button.classList.toggle('active', button.dataset.speed === normalizerSpeedPreset);
    }

    if (readoutVisible) {
      const measured = getControlLoudness();
      normalizerRefs.loudnessValue.textContent = settings.normalizerEnabled && measured !== null
        ? `${measured.toFixed(1)} LUFS`
        : '-- LUFS';
      normalizerRefs.gainValue.textContent = settings.normalizerEnabled
        ? formatSignedDB(loudness.currentGainDB)
        : '0.0 dB';
    }
    normalizerRefs.error.textContent = audio.error;
    normalizerRefs.error.style.display = audio.error ? 'block' : 'none';
  }

  function showNormalizerPanel(video) {
    resetSettingsForNewVideo();
    closePanel();
    ensureNormalizerPanel();
    if (settings.normalizerEnabled) ensureAudioForVideo(video);
    syncNormalizerPanel();

    if (normalizerCloseTimer) {
      clearTimeout(normalizerCloseTimer);
      normalizerCloseTimer = null;
    }
    normalizerPanelOpenedAt = openFloatingPanel(normalizerPanel, video);
    // 面板此刻才真正展开，补一次数值刷新
    requestAnimationFrame(() => syncNormalizerPanel(false));
  }

  function closeNormalizerPanel() {
    normalizerCloseTimer = closeFloatingPanel(normalizerPanel, normalizerCloseTimer);
  }

  function updateMenuCommand(registry, key, label, callback, options) {
    const previousId = registry.get(key);
    const commandOptions = { ...options };
    if (previousId !== undefined && previousId !== null) commandOptions.id = previousId;
    const nextId = GM_registerMenuCommand(label, callback, commandOptions);
    registry.set(key, nextId);
  }

  function registerNormalizerDefaultMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    const label = `${defaultNormalizerEnabled ? '☑' : '☐'} 动态音量默认：${defaultNormalizerEnabled ? '开启' : '关闭'}`;
    updateMenuCommand(normalizerDefaultMenuIds, 'enabled', label, () => {
      defaultNormalizerEnabled = !defaultNormalizerEnabled;
      DEFAULT_SETTINGS.normalizerEnabled = defaultNormalizerEnabled;
      saveNormalizerDefault(defaultNormalizerEnabled);

      settings.normalizerEnabled = defaultNormalizerEnabled;
      resetLoudnessState(true);
      const video = findBestVideo();
      if (settings.normalizerEnabled && video) ensureAudioForVideo(video);
      else applyAudioSettings();
      syncNormalizerPanel();
      registerNormalizerDefaultMenu();
    }, {
      autoClose: false,
      title: '切换新视频打开时动态音量的默认状态',
    });

    const presetMenus = [
      ['comfortable', '舒适', '-16 LUFS'],
      ['standard', '标准', '-14 LUFS'],
      ['loud', '响亮', '-12 LUFS'],
    ];
    for (const [preset, name, target] of presetMenus) {
      const selected = defaultLoudnessPreset === preset;
      updateMenuCommand(
        normalizerDefaultMenuIds,
        `preset-${preset}`,
        `${selected ? '●' : '○'} 动态音量默认档位：${name}（${target}）`,
        () => {
          defaultLoudnessPreset = preset;
          DEFAULT_SETTINGS.loudnessPreset = preset;
          saveDefaultLoudnessPreset(preset);
          settings.loudnessPreset = preset;
          syncNormalizerPanel();
          registerNormalizerDefaultMenu();
        },
        {
          autoClose: false,
          title: `将新视频的动态音量默认档位设为${name}`,
        },
      );
    }
  }

  function registerNormalizerSpeedMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    const speedMenus = [
      ['rapid', '极速', '多人游戏语音'],
      ['fast', '快速', '多人对话'],
      ['balanced', '均衡', '单人远近变化'],
      ['gentle', '平缓', '教程录制'],
      ['slow', '慢速', '稳定音源'],
    ];
    for (const [preset, name, useCase] of speedMenus) {
      const selected = normalizerSpeedPreset === preset;
      updateMenuCommand(
        normalizerSpeedMenuIds,
        preset,
        `${selected ? '●' : '○'} 动态音量响应：${name}（${useCase}）`,
        () => {
          applyNormalizerSpeedPreset(preset);
          saveNormalizerSpeedPreset(preset);
          registerNormalizerSpeedMenu();
        },
        {
          autoClose: false,
          title: `将动态音量响应速度设为${name}`,
        },
      );
    }
  }

  function registerStatusHudMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    const label = `${statusHudEnabled ? '☑' : '☐'} 播放器状态条：${statusHudEnabled ? '显示' : '隐藏'}`;
    updateMenuCommand(statusHudMenuIds, 'enabled', label, () => {
      statusHudEnabled = !statusHudEnabled;
      saveStatusHudEnabled(statusHudEnabled);
      if (statusHudEnabled) syncStatusHud();
      else hideStatusHud();
      registerStatusHudMenu();
    }, {
      autoClose: false,
      title: '切换播放器左上角的音频状态条',
    });

    for (const opacity of STATUS_HUD_OPACITY_OPTIONS) {
      const percent = Math.round(opacity * 100);
      const selected = statusHudOpacity === opacity;
      updateMenuCommand(
        statusHudMenuIds,
        `opacity-${percent}`,
        `${selected ? '●' : '○'} 状态条背景不透明度：${percent}%`,
        () => {
          statusHudOpacity = opacity;
          saveStatusHudOpacity(opacity);
          if (statusHud) statusHud.style.setProperty('--status-bg-opacity', String(opacity));
          registerStatusHudMenu();
        },
        {
          autoClose: false,
          title: `将状态条背景不透明度设为 ${percent}%`,
        },
      );
    }
  }

  function registerBoostMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    const label = `${boostLimiterEnabled ? '☑' : '☐'} 高增益防削波：${boostLimiterEnabled ? '开启' : '关闭'}`;
    updateMenuCommand(boostMenuIds, 'limiter', label, () => {
      boostLimiterEnabled = !boostLimiterEnabled;
      saveBoostLimiterEnabled(boostLimiterEnabled);
      applyLimiterSettings();
      registerBoostMenu();
    }, {
      autoClose: false,
      title: '滚轮音量超过 100% 时是否启用限幅器防止削波（动态音量开启时始终由动态音量接管）',
    });
  }

  function registerWheelVolumeMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    const label = `${wheelVolumeDefaultEnabled ? '☑' : '☐'} 滚轮/方向键调音量默认：${wheelVolumeDefaultEnabled ? '开启' : '关闭'}`;
    updateMenuCommand(wheelVolumeMenuIds, 'enabled', label, () => {
      wheelVolumeDefaultEnabled = !wheelVolumeDefaultEnabled;
      DEFAULT_SETTINGS.wheelVolumeEnabled = wheelVolumeDefaultEnabled;
      saveWheelVolumeDefault(wheelVolumeDefaultEnabled);
      settings.wheelVolumeEnabled = wheelVolumeDefaultEnabled;
      if (!settings.wheelVolumeEnabled) hideVolumeOsd();
      registerWheelVolumeMenu();
    }, {
      autoClose: false,
      title: '切换新视频打开时是否默认允许在网页全屏/全屏下用滚轮（每次 1%）或上下方向键（每次 5%）调节播放器音量（默认开启）',
    });
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 30 || rect.height < 20) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const opacity = Number.parseFloat(style.opacity);
    return !Number.isFinite(opacity) || opacity > 0.05;
  }

  function findVideoAtPoint(x, y) {
    let best = null;
    let largestArea = 0;
    for (const video of document.querySelectorAll('video')) {
      const rect = video.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 60) continue;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      const area = rect.width * rect.height;
      if (area > largestArea) {
        best = video;
        largestArea = area;
      }
    }
    return best;
  }

  function findBestVideo() {
    return [...document.querySelectorAll('video')]
      .filter(isVisible)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return bRect.width * bRect.height - aRect.width * aRect.height;
      })[0] || null;
  }

  function findVideoForControl(control, allowFallback = true) {
    const player = control.closest(PLAYER_SELECTOR);
    if (!player) return allowFallback ? findBestVideo() : null;
    return [...player.querySelectorAll('video')]
      .filter(isVisible)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return bRect.width * bRect.height - aRect.width * aRect.height;
      })[0] || (allowFallback ? findBestVideo() : null);
  }

  function syncToolbarButtons() {
    const enhancerActive = settings.voicePreset !== 'off' || settings.gainDB !== 0;
    const enhancerExpanded = Boolean(panel && panel.style.display !== 'none' && panel.classList.contains('fx-open'));
    for (const button of document.querySelectorAll(`[data-${PREFIX}-toolbar="1"]`)) {
      button.classList.toggle('fx-panel-open', enhancerExpanded);
      button.setAttribute('aria-expanded', String(enhancerExpanded));
      button.title = enhancerActive ? '音频增强（已启用）' : '音频增强';
    }

    const normalizerExpanded = Boolean(normalizerPanel
      && normalizerPanel.style.display !== 'none'
      && normalizerPanel.classList.contains('fx-open'));
    for (const button of document.querySelectorAll(`[data-${PREFIX}-normalizer-toolbar="1"]`)) {
      button.classList.toggle('fx-panel-open', normalizerExpanded);
      button.classList.toggle('fx-feature-enabled', settings.normalizerEnabled);
      button.setAttribute('aria-expanded', String(normalizerExpanded));
      button.title = settings.normalizerEnabled ? '动态音量（已开启）' : '动态音量';
    }
  }

  function createNativeToolbarControl(insertionTarget, nativeClasses, dataName, label, svgMarkup, onActivate, liveMode = false) {
    const control = insertionTarget.cloneNode(false);
    for (const attribute of [...control.attributes]) control.removeAttribute(attribute.name);
    control.className = [...nativeClasses, `${PREFIX}-toolbar`,
      liveMode ? `${PREFIX}-live-toolbar` : ''].filter(Boolean).join(' ');
    control.setAttribute(dataName, '1');
    control.setAttribute('aria-label', label);
    control.setAttribute('aria-haspopup', 'dialog');
    if (control.localName === 'button') {
      control.type = 'button';
    } else {
      control.setAttribute('role', 'button');
      control.tabIndex = 0;
    }

    // 直播间控制栏是 Svelte 产物（哈希类名、无 bpx 图标节点），直接用脚本自己的图标容器
    const nativeIcon = liveMode ? null
      : (insertionTarget.querySelector(':scope > .bpx-player-ctrl-btn-icon')
        || insertionTarget.querySelector('.bpx-player-ctrl-btn-icon'));
    const nativeCommonIcon = nativeIcon && nativeIcon.querySelector('.bpx-common-svg-icon');
    const iconShell = nativeIcon ? nativeIcon.cloneNode(false) : document.createElement('span');
    const commonIcon = nativeCommonIcon ? nativeCommonIcon.cloneNode(false) : document.createElement('span');
    clearDuplicateIds(iconShell);
    clearDuplicateIds(commonIcon);
    iconShell.className = liveMode ? `${PREFIX}-live-toolbar-icon` : 'bpx-player-ctrl-btn-icon';
    commonIcon.className = liveMode ? `${PREFIX}-live-toolbar-svg` : 'bpx-common-svg-icon';
    commonIcon.innerHTML = svgMarkup;
    iconShell.appendChild(commonIcon);
    control.appendChild(iconShell);

    control.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    control.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onActivate(control);
    });
    if (control.localName !== 'button') {
      control.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.code !== 'Space') return;
        event.preventDefault();
        control.click();
      });
    }
    return control;
  }

  function toolbarButtonsIntact() {
    if (!toolbarParents.size) return false;
    for (const parent of toolbarParents) {
      if (!parent.isConnected
        || !parent.querySelector(`:scope > [data-${PREFIX}-toolbar="1"]`)
        || !parent.querySelector(`:scope > [data-${PREFIX}-normalizer-toolbar="1"]`)) return false;
    }
    return true;
  }

  // 直播间：量出控制栏里原生控件占据到的最右边缘
  // （原生控件靠左排列，右侧是空的；用带尺寸的最小元素避免把整行容器算进去）
  function measureLiveNativesRight(bar, barRect) {
    let right = 0;
    for (const node of bar.querySelectorAll('button, i, svg, span, img, canvas')) {
      if (liveToolbarButtons.has(node)) continue;
      if (node.closest(`[data-${PREFIX}-toolbar="1"]`)
        || node.closest(`[data-${PREFIX}-normalizer-toolbar="1"]`)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      if (rect.left < barRect.left - 1 || rect.right > barRect.right + 1) continue;
      right = Math.max(right, rect.right - barRect.left);
    }
    return right;
  }

  // 直播间：把两个按钮排在控制栏内原生控件的右侧，避免重叠
  function layoutLiveToolbar() {
    const bar = liveControlBar;
    if (!bar || !bar.isConnected) return;
    const buttons = [...liveToolbarButtons].filter((button) => button.isConnected);
    if (!buttons.length) return;
    const barRect = bar.getBoundingClientRect();
    // 控制栏隐藏（display:none / 未挂载完）时量不到尺寸，等它显示后由 observer 再排一次
    if (barRect.width < 60 || barRect.height < 12) return;
    const totalWidth = buttons.length * LIVE_TOOLBAR_SLOT_PX;
    const minLeft = Math.max(6, Math.round(measureLiveNativesRight(bar, barRect) + 8));
    const maxLeft = Math.max(6, Math.round(barRect.width - totalWidth - 6));
    const left = Math.min(minLeft, maxLeft);
    buttons.forEach((button, index) => {
      button.style.left = `${left + index * LIVE_TOOLBAR_SLOT_PX}px`;
    });
  }

  // 控制栏本身会显隐（隐藏时子节点跟着隐藏），但它重新显示时尺寸才可用，所以监听它的 style/class 变化补排一次
  function observeLiveControlBar(bar) {
    if (!bar) return;
    if (bar === liveControlBar) {
      layoutLiveToolbar();
      return;
    }
    liveControlBar = bar;
    if (liveControlBarObserver) {
      liveControlBarObserver.disconnect();
      liveControlBarObserver = null;
    }
    if (typeof MutationObserver === 'function') {
      liveControlBarObserver = new MutationObserver(layoutLiveToolbar);
      liveControlBarObserver.observe(bar, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    layoutLiveToolbar();
  }

  // 在同一父节点内保证「音频增强」「动态音量」两个按钮存在（视频页与直播间共用），返回这两个按钮
  function ensureToolbarPair(parent, insertionTarget, nativeClasses, liveMode) {
    let normalizerButton = parent.querySelector(`:scope > [data-${PREFIX}-normalizer-toolbar="1"]`);
    if (!normalizerButton) {
      normalizerButton = createNativeToolbarControl(
        insertionTarget,
        nativeClasses,
        `data-${PREFIX}-normalizer-toolbar`,
        '动态音量',
        `<svg class="${PREFIX}-toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12h4l3-8 4 16 3-8h4"/>
        </svg>`,
        (control) => {
          if (normalizerPanel && normalizerPanel.style.display !== 'none'
            && normalizerPanel.classList.contains('fx-open')) {
            closeNormalizerPanel();
            return;
          }
          showNormalizerPanel(findVideoForControl(control));
        },
        liveMode,
      );
    }

    let enhancerButton = parent.querySelector(`:scope > [data-${PREFIX}-toolbar="1"]`);
    if (!enhancerButton) {
      enhancerButton = createNativeToolbarControl(
        insertionTarget,
        nativeClasses,
        `data-${PREFIX}-toolbar`,
        '音频增强',
        `<svg class="${PREFIX}-toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 6h7M15 6h5M4 12h3M11 12h9M4 18h9M17 18h3"/>
          <path d="M11 4v4M7 10v4M17 16v4"/>
        </svg>`,
        (control) => {
          if (panel && panel.style.display !== 'none' && panel.classList.contains('fx-open')) {
            closePanel();
            return;
          }
          showPanel(findVideoForControl(control));
        },
        liveMode,
      );
    }

    return { enhancerButton, normalizerButton };
  }

  function ensureToolbarButtons() {
    const scanAt = performance.now();
    // 按钮仍在原位时跳过全量扫描，最多每 2 秒兜底扫描一次
    if (toolbarButtonsIntact() && scanAt - toolbarFullScanAt < 2000) return;
    toolbarFullScanAt = scanAt;
    ensureStyles();
    toolbarParents.clear();
    const volumeControls = new Set(document.querySelectorAll([
      '.bpx-player-ctrl-volume',
      '.bpx-player-rich-pip-volume',
      '.bilibili-player-video-btn-volume',
    ].join(',')));

    for (const volumeControl of volumeControls) {
      const insertionTarget = volumeControl.closest('.bpx-player-ctrl-btn, .bilibili-player-video-btn')
        || volumeControl;
      const parent = insertionTarget.parentElement;
      if (!parent) continue;
      toolbarParents.add(parent);
      const nativeClasses = [...insertionTarget.classList]
        .filter((name) => name === 'bpx-player-ctrl-btn' || name === 'bilibili-player-video-btn');

      const { enhancerButton, normalizerButton } =
        ensureToolbarPair(parent, insertionTarget, nativeClasses, false);

      if (enhancerButton.nextElementSibling !== normalizerButton
        || normalizerButton.nextElementSibling !== insertionTarget) {
        parent.insertBefore(enhancerButton, insertionTarget);
        parent.insertBefore(normalizerButton, insertionTarget);
      }
    }

    // 直播间：控制栏是播放器 SDK 运行时创建的 Svelte 节点，内部类名带哈希、没有 bpx 图标节点，
    // 所以不猜「音量按钮」，而是把两个按钮插进控制栏本身（.web-player-controller-bg）：
    // 它在隐藏时子节点跟着隐藏（显隐天然同步），位置由 layoutLiveToolbar() 在运行时排在原生控件右侧。
    const liveBar = document.querySelector(LIVE_CONTROL_BAR_SELECTOR);
    if (liveBar) {
      toolbarParents.add(liveBar);
      const { enhancerButton, normalizerButton } = ensureToolbarPair(liveBar, liveBar, [], true);
      if (liveBar.firstElementChild !== enhancerButton
        || enhancerButton.nextElementSibling !== normalizerButton) {
        liveBar.insertBefore(normalizerButton, liveBar.firstChild);
        liveBar.insertBefore(enhancerButton, liveBar.firstChild);
      }
      liveToolbarButtons.add(enhancerButton);
      liveToolbarButtons.add(normalizerButton);
      observeLiveControlBar(liveBar);
    }

    syncToolbarButtons();
  }

  function scheduleToolbarInjection() {
    if (toolbarScanScheduled) return;
    toolbarScanScheduled = true;
    requestAnimationFrame(() => {
      toolbarScanScheduled = false;
      ensureToolbarButtons();
    });
  }

  function menuHasNativeLabels(menu) {
    const text = menu.textContent || '';
    return ['复制视频地址', '快捷键说明', '视频统计信息', '更新历史']
      .filter((label) => text.includes(label)).length >= 2;
  }

  function findVisibleNativeMenus() {
    const candidates = new Set();
    const selectors = [
      '.bpx-player-contextmenu',
      '.bpx-player-contextmenu-wrap',
      '.bilibili-player-context-menu-container',
      'ul[class*="context-menu"]',
      'ul[class*="contextmenu"]',
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) candidates.add(element);
    }
    for (const element of document.querySelectorAll('ul')) {
      if (menuHasNativeLabels(element)) candidates.add(element);
    }
    const visible = [...candidates].filter((element) => isVisible(element) && menuHasNativeLabels(element));
    return visible.filter((element) => !visible.some((other) => other !== element && element.contains(other)));
  }

  function findMenuItem(menu, label) {
    const selector = 'li,[role="menuitem"],[class*="contextmenu-item"],[class*="context-menu-item"],div,span';
    const exact = [...menu.querySelectorAll(selector)]
      .filter((element) => element.textContent.trim() === label)
      .sort((a, b) => a.childElementCount - b.childElementCount)[0];
    if (!exact) return null;
    const item = exact.closest('li,[role="menuitem"],[class*="contextmenu-item"],[class*="context-menu-item"]');
    return item && menu.contains(item) ? item : exact;
  }

  function clearDuplicateIds(root) {
    if (root.id) root.removeAttribute('id');
    for (const element of root.querySelectorAll('[id]')) element.removeAttribute('id');
  }

  function restoreHiddenNativeMenus() {
    for (const menu of document.querySelectorAll(`[data-${PREFIX}-hidden="1"]`)) {
      menu.style.removeProperty('display');
      menu.removeAttribute(`data-${PREFIX}-hidden`);
    }
  }

  function hideNativeMenu(menu) {
    menu.style.setProperty('display', 'none', 'important');
    menu.setAttribute(`data-${PREFIX}-hidden`, '1');
  }

  function bindScriptMenuItem(item, menu, panelType) {
    if (boundScriptMenuItems.has(item)) return;
    boundScriptMenuItems.add(item);
    item.setAttribute(`data-${PREFIX}-bound`, '1');
    let activated = false;

    const activate = (event) => {
      if (activated) return;
      activated = true;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const video = lastContextVideo || findBestVideo();
      hideNativeMenu(menu);
      setTimeout(() => {
        if (panelType === 'normalizer') showNormalizerPanel(video);
        else showPanel(video);
        activated = false;
      }, 0);
    };

    item.addEventListener('pointerdown', activate, true);
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, true);
    item.addEventListener('click', (event) => {
      if (event.detail === 0 && !activated) {
        activate(event);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }, true);
  }

  function injectMenuItem(menu) {
    const quickHelp = findMenuItem(menu, '快捷键说明');
    const copyAddress = findMenuItem(menu, '复制视频地址（精准空降）')
      || findMenuItem(menu, '复制视频地址');
    const template = quickHelp || copyAddress;
    if (!template || !template.parentElement) return;
    const beforeNode = quickHelp || template.nextSibling;

    // 保存菜单当前位置，避免注入后位置跳动
    const menuStyle = window.getComputedStyle(menu);
    const savedLeft = menu.style.left || menuStyle.left;
    const savedTop = menu.style.top || menuStyle.top;

    const ensureEntry = (label, panelType) => {
      let item = findMenuItem(menu, label);
      if (!item) {
        item = template.cloneNode(true);
        clearDuplicateIds(item);
        item.textContent = label;
        item.setAttribute(`data-${PREFIX}-item`, panelType);
        template.parentElement.insertBefore(item, beforeNode);
      }
      bindScriptMenuItem(item, menu, panelType);
    };

    ensureEntry(MENU_LABEL, 'enhancer');
    ensureEntry(NORMALIZER_MENU_LABEL, 'normalizer');

    // 标记当前菜单已完成注入；后续仍会检查条目是否被页面重建。
    menu.setAttribute(`data-${PREFIX}-injected`, '1');

    // 恢复菜单位置，避免浏览器自动调整导致位置变动
    if (savedLeft && savedTop) {
      menu.style.left = savedLeft;
      menu.style.top = savedTop;
    }
  }

  function injectVisibleMenus() {
    if (Date.now() > injectUntil) return;
    for (const menu of findVisibleNativeMenus()) injectMenuItem(menu);
  }

  function scheduleMenuInjection() {
    // 减少延迟注入次数，避免菜单多次变化导致位置错位
    for (const delay of [0, 16, 80]) setTimeout(injectVisibleMenus, delay);
  }

  function install() {
    registerNormalizerDefaultMenu();
    registerNormalizerSpeedMenu();
    registerStatusHudMenu();
    registerBoostMenu();
    registerWheelVolumeMenu();
    if (!statusHudTimer) {
      statusHudTimer = setInterval(syncStatusHud, STATUS_HUD_UPDATE_MS);
    }
    document.addEventListener('contextmenu', (event) => {
      if ((panel && panel.contains(event.target))
        || (normalizerPanel && normalizerPanel.contains(event.target))) return;
      restoreHiddenNativeMenus();
      closePanel();
      closeNormalizerPanel();
      const video = findVideoAtPoint(event.clientX, event.clientY);
      if (!video) return;
      lastContextVideo = video;
      injectUntil = Date.now() + 1500;
      scheduleMenuInjection();
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closePanel();
        closeNormalizerPanel();
      }
      if (event.target instanceof Element
        && event.target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      if (!event.ctrlKey && !event.altKey && !event.metaKey
        && (event.code === 'Space' || event.key.toLowerCase() === 'k')) {
        resetSettingsForNewVideo();
        autoApplySavedEffect(findBestVideo(), true);
      }
    }, true);

    const applyOnPlayback = (event) => {
      if (event.target instanceof HTMLVideoElement) {
        resetSettingsForNewVideo();
        autoApplySavedEffect(event.target);
      }
    };
    document.addEventListener('play', applyOnPlayback, true);
    document.addEventListener('playing', applyOnPlayback, true);
    // 在播放器的 document/控件监听器之前接管滚轮调音量，避免同一事件被重复处理。
    window.addEventListener('wheel', handleVolumeWheel, { capture: true, passive: false });
    // 同样在捕获阶段接管网页全屏/全屏下的上下方向键调音量
    window.addEventListener('keydown', handleVolumeKey, true);
    document.addEventListener('volumechange', handleVolumeChange, true);
    // 面板每次重新展开时 B站会把数字重置为 100，这里补写回当前倍率
    document.addEventListener('mouseover', (event) => {
      if (settings.boostPercent <= BOOST_MIN_PERCENT) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const volumeControl = findVolumeControl(target);
      if (!volumeControl) return;
      lastVolumeControl = volumeControl;
      scheduleVolumeReadoutSync(volumeControl);
    }, true);

    document.addEventListener('pointerdown', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (panel && panel.style.display !== 'none'
        && performance.now() - panelOpenedAt >= 80
        && !(target && target.closest(`[data-${PREFIX}-toolbar="1"]`))
        && !panel.contains(event.target)) {
        closePanel();
      }
      if (normalizerPanel && normalizerPanel.style.display !== 'none'
        && performance.now() - normalizerPanelOpenedAt >= 80
        && !(target && target.closest(`[data-${PREFIX}-normalizer-toolbar="1"]`))
        && !normalizerPanel.contains(event.target)) {
        closeNormalizerPanel();
      }
      resetSettingsForNewVideo();
      if (hasSavedEffect()) {
        const video = findVideoAtPoint(event.clientX, event.clientY) || findBestVideo();
        autoApplySavedEffect(video, true);
      }
      if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
    }, true);

    document.addEventListener('fullscreenchange', closePanel);
    document.addEventListener('webkitfullscreenchange', closePanel);
    document.addEventListener('fullscreenchange', closeNormalizerPanel);
    document.addEventListener('webkitfullscreenchange', closeNormalizerPanel);
    document.addEventListener('fullscreenchange', () => requestAnimationFrame(syncStatusHud));
    document.addEventListener('webkitfullscreenchange', () => requestAnimationFrame(syncStatusHud));
    // 直播间按钮的水平位置是按控制栏实测宽度算的，尺寸变化后要重排
    document.addEventListener('fullscreenchange', () => requestAnimationFrame(layoutLiveToolbar));
    document.addEventListener('webkitfullscreenchange', () => requestAnimationFrame(layoutLiveToolbar));
    document.addEventListener('fullscreenchange', hideVolumeOsd);
    document.addEventListener('webkitfullscreenchange', hideVolumeOsd);
    window.addEventListener('resize', hideVolumeOsd, { passive: true });
    window.addEventListener('scroll', hideVolumeOsd, { capture: true, passive: true });
    window.addEventListener('resize', syncStatusHud, { passive: true });
    window.addEventListener('resize', layoutLiveToolbar, { passive: true });
    window.addEventListener('popstate', resetSettingsForNewVideo);

    let lastMutationTime = 0;
    let pendingMutationScanTimer = null;
    const MUTATION_THROTTLE_MS = 100;
    const processExternalMutations = () => {
      pendingMutationScanTimer = null;
      lastMutationTime = Date.now();
      resetSettingsForNewVideo();
      scheduleToolbarInjection();
      if (Date.now() <= injectUntil) injectVisibleMenus();
    };
    const observer = new MutationObserver((mutations) => {
      // 已经安排了延迟扫描时直接返回，避免对整批 mutation 逐条 closest
      if (pendingMutationScanTimer) return;
      const hasExternalMutation = mutations.some((mutation) => {
        const target = mutation.target instanceof Element
          ? mutation.target
          : mutation.target.parentElement;
        return !target || (!target.closest(`.${PREFIX}-panel-shell`)
          && !target.closest(`.${PREFIX}-status-hud`));
      });
      if (!hasExternalMutation) return;

      const remainingMs = MUTATION_THROTTLE_MS - (Date.now() - lastMutationTime);
      if (remainingMs <= 0 && !pendingMutationScanTimer) {
        processExternalMutations();
      } else if (!pendingMutationScanTimer) {
        pendingMutationScanTimer = setTimeout(processExternalMutations, Math.max(0, remainingMs));
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleToolbarInjection();
  }

  install();
})();
