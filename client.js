/**
 * Browser half of `dsh-web-search-bing`.
 *
 * Registers one Settings page into the Settings surface's `settings.section`
 * slot, so this plugin's 14 configuration keys can be edited in the GUI instead
 * of the profile's `cordis.patch.yml`. The page reads and writes the plugin's
 * Loader entry (`web-search-bing`) through the shared `configForms` service,
 * which is the same path the shipped settings pages use.
 *
 * The entry is fail-safe by construction: the whole module sits inside a guard,
 * the factory is guarded, and registration is wrapped so a missing loader, a
 * missing slot, or a missing service leaves the rest of the page untouched.
 *
 * @module dsh-web-search-bing/client
 */
(function () {
  'use strict';

  /** Log without letting a console failure escape. */
  function warn(error) {
    try {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[dsh-web-search-bing] client:', error);
      }
    } catch (ignored) {
      /* nothing to do */
    }
  }

  try {
    if (typeof window === 'undefined') return;
    var loader = window.__ModuleLoader__;
    if (loader === null || typeof loader !== 'object' || typeof loader.load !== 'function') return;

    loader.load({
      id: 'dsh-web-search-bing',
      factory: function (require) {
        try {
          var React = require('react');
          var h = React.createElement;

          /** Dictionary namespace owned by this plugin. */
          var NS = 'webSearchBing';
          /** The Settings surface slot: one settings page per list entry. */
          var SLOT = 'settings.section';
          /** Loader entry id the Host projects this plugin's Config under. */
          var ENTRY = 'web-search-bing';
          /** Snapshot used while no configuration service is reachable. */
          var EMPTY_STATE = { status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false };

          // English copy. Every label the page renders lives here.
          var en = {
            title: 'Web search (Bing)',
            description: 'Edit the key-free search provider: engine allow-list, wait policy, proxy, result budget, ranking, cache and cooldowns.',
            'group.engines': 'Engines and transport',
            'group.ranking': 'Results and ranking',
            'group.cache': 'Cache and cooldowns',
            'field.hosts': 'Engine allow-list',
            'field.wait': 'Wait policy',
            'field.timeoutMs': 'Timeout (ms)',
            'field.proxy': 'Proxy URL',
            'field.limit': 'Result budget',
            'field.rrfConstant': 'RRF constant',
            'field.authorityDomains': 'Authority domains',
            'field.authorityBoost': 'Authority boost',
            'field.freshnessBoost': 'Freshness boost',
            'field.freshnessDays': 'Freshness window (days)',
            'field.cacheTtlMs': 'Cache TTL (ms)',
            'field.cacheEntries': 'Cache entries',
            'field.baseCooldownMs': 'Base cooldown (ms)',
            'field.maxCooldownMs': 'Max cooldown (ms)',
            'hint.hosts': 'Comma-separated engine ids: anysearch, ddg-html, ddg-lite, www.bing, cn.bing, so. Empty allows every engine.',
            'hint.wait': 'auto follows the query language; all waits for every engine; fast returns on the first answer.',
            'hint.timeoutMs': 'Per-engine request deadline, at least 500 ms.',
            'hint.proxy': 'Tunnel such as http://127.0.0.1:7890. Empty detects the environment, then the macOS system proxy.',
            'hint.limit': 'Maximum sources returned, 1 to 20; the caller budget still caps it.',
            'hint.rrfConstant': 'Reciprocal-rank-fusion constant; larger values flatten the rank curve.',
            'hint.authorityDomains': 'Extra domains earning the authority boost, comma-separated.',
            'hint.authorityBoost': 'Multiplier for authoritative domains, 0 to 10.',
            'hint.freshnessBoost': 'Multiplier for results published today, 0 to 10.',
            'hint.freshnessDays': 'Age in days at which the freshness boost has faded to zero.',
            'hint.cacheTtlMs': 'Result cache lifetime; 0 disables the cache.',
            'hint.cacheEntries': 'Maximum cached queries before the least recently used one is evicted.',
            'hint.baseCooldownMs': 'Cooldown after a throttling failure that carried no wait hint.',
            'hint.maxCooldownMs': 'Ceiling for the exponential cooldown.',
            'wait.auto': 'Auto (query language)',
            'wait.all': 'All engines',
            'wait.fast': 'Fastest answer',
            loading: 'Loading configuration…',
            unavailable: 'This plugin\'s settings are not available in this deployment yet.',
            readOnly: 'This deployment stores settings read-only.',
            save: 'Save',
            saving: 'Saving…',
            discard: 'Discard changes',
            saved: 'Saved.',
            saveFailed: 'The deployment did not accept these values; they were kept for correction.',
            invalidNumber: 'Enter a number within the allowed range, or leave blank for the default.'
          };

          // Simplified Chinese copy.
          var zh = {
            title: '网页搜索（Bing）',
            description: '编辑免密钥搜索提供方：引擎白名单、等待策略、代理、结果上限、排序、缓存与冷却。',
            'group.engines': '引擎与传输',
            'group.ranking': '结果与排序',
            'group.cache': '缓存与冷却',
            'field.hosts': '引擎白名单',
            'field.wait': '等待策略',
            'field.timeoutMs': '超时（毫秒）',
            'field.proxy': '代理地址',
            'field.limit': '结果上限',
            'field.rrfConstant': 'RRF 常数',
            'field.authorityDomains': '权威域名',
            'field.authorityBoost': '权威加权',
            'field.freshnessBoost': '新鲜度加权',
            'field.freshnessDays': '新鲜度窗口（天）',
            'field.cacheTtlMs': '缓存有效期（毫秒）',
            'field.cacheEntries': '缓存条目上限',
            'field.baseCooldownMs': '基础冷却（毫秒）',
            'field.maxCooldownMs': '最大冷却（毫秒）',
            'hint.hosts': '逗号分隔的引擎 id：anysearch、ddg-html、ddg-lite、www.bing、cn.bing、so；留空表示全部引擎。',
            'hint.wait': 'auto 按提问语言决定；all 等待全部引擎；fast 首个回答即返回。',
            'hint.timeoutMs': '单个引擎的请求截止时间，至少 500 毫秒。',
            'hint.proxy': '例如 http://127.0.0.1:7890；留空时先读环境变量，再读 macOS 系统代理。',
            'hint.limit': '最多返回的来源数，1–20；调用方预算仍会收窄该值。',
            'hint.rrfConstant': '倒数排名融合常数；值越大排名曲线越平缓。',
            'hint.authorityDomains': '额外获得权威加权的域名，逗号分隔。',
            'hint.authorityBoost': '权威域名的加权倍数，0–10。',
            'hint.freshnessBoost': '当天发布结果的加权倍数，0–10。',
            'hint.freshnessDays': '新鲜度加权衰减为零所需的天数。',
            'hint.cacheTtlMs': '结果缓存有效期；0 表示关闭缓存。',
            'hint.cacheEntries': '缓存查询数上限，超出后淘汰最久未用的条目。',
            'hint.baseCooldownMs': '限流失败且没有等待提示时的冷却时间。',
            'hint.maxCooldownMs': '指数冷却的上限。',
            'wait.auto': '自动（按提问语言）',
            'wait.all': '等待全部引擎',
            'wait.fast': '最快回答',
            loading: '正在读取配置…',
            unavailable: '当前部署尚未提供此插件的设置。',
            readOnly: '本部署的设置为只读。',
            save: '保存',
            saving: '保存中…',
            discard: '放弃更改',
            saved: '已保存。',
            saveFailed: '本部署没有接受这些值，已保留供你修改。',
            invalidNumber: '请填写允许范围内的数字；留空表示使用默认值。'
          };

          /** Field descriptors: schema key, group, control kind and bounds. */
          var FIELDS = [
            { key: 'hosts', group: 'engines', kind: 'list' },
            { key: 'wait', group: 'engines', kind: 'select', options: ['auto', 'all', 'fast'] },
            { key: 'timeoutMs', group: 'engines', kind: 'number', integer: true, min: 500 },
            { key: 'proxy', group: 'engines', kind: 'text' },
            { key: 'limit', group: 'ranking', kind: 'number', integer: true, min: 1, max: 20 },
            { key: 'rrfConstant', group: 'ranking', kind: 'number', integer: true, min: 1 },
            { key: 'authorityDomains', group: 'ranking', kind: 'list' },
            { key: 'authorityBoost', group: 'ranking', kind: 'number', min: 0, max: 10 },
            { key: 'freshnessBoost', group: 'ranking', kind: 'number', min: 0, max: 10 },
            { key: 'freshnessDays', group: 'ranking', kind: 'number', integer: true, min: 1 },
            { key: 'cacheTtlMs', group: 'cache', kind: 'number', integer: true, min: 0 },
            { key: 'cacheEntries', group: 'cache', kind: 'number', integer: true, min: 0 },
            { key: 'baseCooldownMs', group: 'cache', kind: 'number', integer: true, min: 0 },
            { key: 'maxCooldownMs', group: 'cache', kind: 'number', integer: true, min: 0 }
          ];

          /** Groups in render order. */
          var GROUPS = ['engines', 'ranking', 'cache'].map(function (group) {
            return { key: group, fields: FIELDS.filter(function (field) { return field.group === group; }) };
          });

          var groupStyle = {
            display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px',
            border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
            background: 'var(--dsw-alias-bg-layer-2)'
          };
          var gridStyle = {
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: '10px 14px'
          };
          var labelStyle = {
            display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 600,
            lineHeight: 1.4, color: 'var(--dsw-alias-label-secondary)'
          };
          var hintStyle = {
            display: 'block', marginTop: '4px', fontSize: '11px', lineHeight: 1.45,
            color: 'var(--dsw-alias-label-tertiary)'
          };
          var errorStyle = {
            display: 'block', marginTop: '4px', fontSize: '11px', lineHeight: 1.45,
            color: 'var(--dsw-alias-state-error-primary)'
          };
          var inputStyle = {
            boxSizing: 'border-box', width: '100%', padding: '6px 8px', fontSize: '13px',
            lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '6px'
          };
          var buttonStyle = {
            font: 'inherit', fontSize: '13px', lineHeight: 1.4, padding: '6px 14px',
            borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)',
            background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer'
          };
          var primaryStyle = Object.assign({}, buttonStyle, {
            background: 'var(--dsw-alias-button-primary-fill)',
            borderColor: 'var(--dsw-alias-button-primary-fill)',
            color: 'var(--dsw-alias-label-primary-foreground)'
          });

          /** A state snapshot that never changes, for the no-service case. */
          function emptySnapshot() { return EMPTY_STATE; }

          /** React 18's external-store hook, with a small fallback. */
          var useSync = typeof React.useSyncExternalStore === 'function'
            ? React.useSyncExternalStore
            : function (subscribe, getSnapshot) {
              var pair = React.useState(getSnapshot);
              React.useEffect(function () {
                return subscribe(function () { pair[1](getSnapshot()); });
              }, [subscribe, getSnapshot]);
              return pair[0];
            };

          /** Field values as editable text. */
          function toDraft(values) {
            var draft = {};
            for (var i = 0; i < FIELDS.length; i += 1) {
              var field = FIELDS[i];
              var value = values === undefined ? undefined : values[field.key];
              draft[field.key] = field.kind === 'list'
                ? (Array.isArray(value) ? value.join(', ') : '')
                : (value === undefined || value === null ? '' : String(value));
            }
            return draft;
          }

          /** Split a comma/whitespace separated list. */
          function splitList(text) {
            return String(text === undefined || text === null ? '' : text)
              .split(/[\s,]+/)
              .filter(function (part) { return part.length > 0; });
          }

          /** Convert one draft value into a form operation, or record an error. */
          function operation(field, raw, current, errors, t) {
            var key = field.key;
            if (field.kind === 'list') {
              var list = splitList(raw);
              var previous = Array.isArray(current) ? current : [];
              if (JSON.stringify(list) === JSON.stringify(previous)) return null;
              return { op: 'set', path: [key], value: list };
            }
            if (field.kind === 'select') {
              if (raw === current) return null;
              return raw === '' ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value: raw };
            }
            if (field.kind === 'text') {
              var text = String(raw === undefined || raw === null ? '' : raw);
              if (text === current) return null;
              return { op: 'set', path: [key], value: text };
            }
            var trimmed = String(raw === undefined || raw === null ? '' : raw).trim();
            if (trimmed === '') {
              return current === undefined ? null : { op: 'unset', path: [key] };
            }
            var numeric = Number(trimmed);
            var invalid = !isFinite(numeric)
              || (field.integer === true && Math.floor(numeric) !== numeric)
              || (field.min !== undefined && numeric < field.min)
              || (field.max !== undefined && numeric > field.max);
            if (invalid) {
              errors[key] = t('invalidNumber');
              return null;
            }
            if (numeric === current) return null;
            return { op: 'set', path: [key], value: numeric };
          }

          /** One page of the Settings surface. */
          function SettingsPage(props) {
            var t = props.t;
            var form = props.form;
            var subscribe = React.useCallback(function (listener) {
              return form && typeof form.subscribe === 'function' ? form.subscribe(listener) : function () {};
            }, [form]);
            var getSnapshot = React.useCallback(function () {
              return form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : emptySnapshot();
            }, [form]);
            var state = useSync(subscribe, getSnapshot);
            var draftPair = React.useState(null);
            var draft = draftPair[0];
            var setDraft = draftPair[1];
            var savePair = React.useState('idle');
            var phase = savePair[0];
            var setPhase = savePair[1];
            var errorPair = React.useState({});
            var errors = errorPair[0];
            var setErrors = errorPair[1];

            React.useEffect(function () {
              setDraft(null);
              setPhase('idle');
              setErrors({});
            }, [state.revision]);

            var ready = form !== null && form !== undefined && state.status === 'ready';
            var values = ready && state.value !== null && typeof state.value === 'object' ? state.value : {};
            var current = draft === null ? toDraft(values) : draft;

            function edit(key, text) {
              var next = Object.assign({}, current);
              next[key] = text;
              setDraft(next);
              setPhase('idle');
              if (errors[key] !== undefined) {
                var cleared = Object.assign({}, errors);
                delete cleared[key];
                setErrors(cleared);
              }
            }

            function save() {
              if (!ready || state.writable === false || phase === 'saving') return;
              var nextErrors = {};
              var operations = [];
              for (var i = 0; i < FIELDS.length; i += 1) {
                var op = operation(FIELDS[i], current[FIELDS[i].key], values[FIELDS[i].key], nextErrors, t);
                if (op !== null) operations.push(op);
              }
              if (Object.keys(nextErrors).length > 0) {
                setErrors(nextErrors);
                setPhase('idle');
                return;
              }
              if (operations.length === 0) {
                setDraft(null);
                setPhase('saved');
                return;
              }
              setPhase('saving');
              setErrors({});
              Promise.resolve(form.mutate(operations, state.revision)).then(function (accepted) {
                if (accepted === false) {
                  setPhase('failed');
                  return;
                }
                setDraft(null);
                setPhase('saved');
              }, function (error) {
                warn(error);
                setPhase('failed');
              });
            }

            var children = [
              h('h3', { key: 'title', style: { margin: 0, fontSize: '16px', lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' } }, t('title')),
              h('p', { key: 'description', style: { margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } }, t('description'))
            ];

            if (!ready) {
              var note = state.status === 'loading' ? 'loading' : (state.status === 'unavailable' ? 'unavailable' : 'unavailable');
              children.push(h('p', { key: 'note', style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' }, role: 'status' }, t(note)));
              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)' } }, children);
            }

            if (state.writable === false) {
              children.push(h('p', { key: 'readonly', style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('readOnly')));
            }

            children.push(h('div', { key: 'groups', style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, GROUPS.map(function (group) {
              return h('section', { key: group.key, style: groupStyle }, [
                h('h4', { key: 'title', style: { margin: 0, fontSize: '13px', lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' } }, t('group.' + group.key)),
                h('div', { key: 'grid', style: gridStyle }, group.fields.map(function (field) {
                  var key = field.key;
                  var disabled = state.writable === false || phase === 'saving';
                  var control;
                  if (field.kind === 'select') {
                    control = h('select', {
                      value: current[key],
                      disabled: disabled,
                      style: inputStyle,
                      onChange: function (event) { edit(key, event.target.value); }
                    }, field.options.map(function (option) {
                      return h('option', { key: option, value: option }, t('wait.' + option));
                    }));
                  } else {
                    control = h('input', {
                      type: field.kind === 'number' ? 'number' : 'text',
                      value: current[key],
                      disabled: disabled,
                      inputMode: field.kind === 'number' ? 'decimal' : undefined,
                      min: field.min,
                      max: field.max,
                      step: field.kind === 'number' && field.integer === true ? 1 : undefined,
                      placeholder: field.kind === 'number' ? 'default' : undefined,
                      spellCheck: false,
                      style: inputStyle,
                      onChange: function (event) { edit(key, event.target.value); }
                    });
                  }
                  return h('label', { key: key, style: { display: 'block', minWidth: 0 } }, [
                    h('span', { key: 'label', style: labelStyle }, t('field.' + key)),
                    control,
                    errors[key] !== undefined
                      ? h('span', { key: 'error', style: errorStyle, role: 'alert' }, errors[key])
                      : h('span', { key: 'hint', style: hintStyle }, t('hint.' + key))
                  ]);
                }))
              ]);
            })));

            var footer = [
              h('button', {
                key: 'save', type: 'button', style: primaryStyle,
                disabled: state.writable === false || phase === 'saving',
                onClick: save
              }, t(phase === 'saving' ? 'saving' : 'save')),
              h('button', {
                key: 'discard', type: 'button', style: buttonStyle,
                disabled: state.writable === false || phase === 'saving' || draft === null,
                onClick: function () {
                  setDraft(null);
                  setErrors({});
                  setPhase('idle');
                }
              }, t('discard'))
            ];
            if (phase === 'saved') footer.push(h('span', { key: 'status', style: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' }, role: 'status' }, t('saved')));
            if (phase === 'failed') footer.push(h('span', { key: 'status', style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' }, role: 'alert' }, t('saveFailed')));
            children.push(h('div', { key: 'footer', style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, footer));

            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)' } }, children);
          }

          /** At most one live registration; the slot may appear more than once. */
          var live = null;
          var applied = false;

          /**
           * Mount the settings page.
           * @param ctx - the browser plugin context.
           */
          function apply(ctx) {
            if (applied) return;
            try {
              if (ctx === null || ctx === undefined) return;
              if (ctx.slots === undefined || ctx.locale === undefined) return;
              if (typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') return;
              if (typeof ctx.locale.register !== 'function') return;
              applied = true;

              var t = ctx.locale.bind(NS);
              if (typeof ctx.effect === 'function') {
                ctx.effect(function () {
                  return ctx.locale.register(NS, { zh: zh, en: en });
                }, 'web-search-bing: settings dictionaries');
              } else {
                ctx.locale.register(NS, { zh: zh, en: en });
              }

              var form = null;
              try {
                if (ctx.configForms !== undefined && ctx.configForms !== null && typeof ctx.configForms.get === 'function') {
                  form = ctx.configForms.get(ENTRY);
                }
              } catch (error) {
                warn(error);
              }

              ctx.slots.inject(SLOT, function () {
                if (live !== null) return live;
                var dispose;
                try {
                  dispose = ctx.slots.register({
                    name: SLOT,
                    id: ENTRY,
                    order: 40,
                    label: function () { return t('title'); },
                    locale: NS
                  }, function (props) {
                    return h(SettingsPage, Object.assign({}, props, { t: t, form: form }));
                  });
                } catch (error) {
                  warn(error);
                  return function () {};
                }
                if (typeof dispose !== 'function') return function () {};
                live = function () {
                  try {
                    dispose();
                  } catch (error) {
                    warn(error);
                  } finally {
                    live = null;
                  }
                };
                return live;
              });
            } catch (error) {
              warn(error);
            }
          }

          return { inject: ['slots', 'locale'], apply: apply };
        } catch (error) {
          warn(error);
          return { apply: function () {} };
        }
      }
    });
  } catch (error) {
    warn(error);
  }
})();
