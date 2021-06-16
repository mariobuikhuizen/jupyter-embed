import { isEqual, cloneDeep } from 'lodash';

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function requireAsync(urls) {
  return new Promise((resolve, reject) => {
    try {
      window.requirejs(urls, (...args) => {
        resolve(args);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function getWidgetManager(voila, kernel) {
  function connect() {
  }

  return new voila.WidgetManager({
    saveState: { connect },
    sessionContext: {
      session: { kernel },
      kernelChanged: { connect },
      statusChanged: { connect },
      connectionStatusChanged: { connect },
    },
  },
  new voila.RenderMimeRegistry(),
  { saveState: false });
}

function removeExtensionLoading(widgetManager) {
  class ModelMock {
    /* eslint-disable class-methods-use-this, no-underscore-dangle, camelcase */
    once() {}

    get() {}

    static _deserialize_state() {
      return {};
    }
    /* eslint-enable class-methods-use-this, no-underscore-dangle, camelcase */
  }

  const orgLoadClass = widgetManager.loadClass.bind(widgetManager);
  // eslint-disable-next-line no-param-reassign
  widgetManager.loadClass = async (className, moduleName, moduleVersion) => {
    if (className === 'WidgetModel') {
      return orgLoadClass(className, moduleName, moduleVersion);
    }
    return ModelMock;
  };
}

const widgetResolveFns = {};
const widgetPromises = {};

function provideWidget(modelId, widgetModel) {
  if (widgetResolveFns[modelId]) {
    widgetResolveFns[modelId](widgetModel);
  } else {
    widgetPromises[modelId] = Promise.resolve(widgetModel);
  }
}

export function requestWidget(modelId) {
  if (!widgetPromises[modelId]) {
    widgetPromises[modelId] = new Promise((resolve) => { widgetResolveFns[modelId] = resolve; });
  }
  return widgetPromises[modelId];
}

/**
 * Creates a Mixin to connect a widget model to a Vue model bi directionally.
 *
 * In addition to the conneted properties in `propList`, `jupyter_model` is added, which gives
 * direct access to the jupyter-model.
 *
 * @param mountId  The mountId specified in Widget._metadata
 * @param propList The property names to connect
 * @returns {a Vue mixin}
 */
export function jupyterModelMixinFactory(mountId, propList) {
  return {
    async created() {
      const model = await requestWidget({ mountId });
      propList.forEach((prop) => {
        this[prop] = model.get(prop);
        model.on(`change:${prop}`, () => {
          if (!isEqual(this.prop, model.get(prop))) {
            this[prop] = cloneDeep(model.get(prop));
          }
        });
      });

      this.jupyter_model = model;
    },
    data() {
      return {
        jupyter_model: null,
        ...propList.reduce((accum, prop) => ({ ...accum, [prop]: null }), {}),
      };
    },
    watch: {
      ...propList.reduce((accum, prop) => ({
        ...accum,
        [prop]: {
          deep: true,
          handler(value) {
            if (!isEqual(value, this.jupyter_model.get(prop))) {
              this.jupyter_model.set(prop, cloneDeep(value));
              this.jupyter_model.save_changes();
            }
          },
        },
      }), {}),
    },
  };
}

export async function connectToJupyterKernel(kernelid, baseUrl) {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/require.js/2.3.6/require.min.js');

  const [voila] = await requireAsync([`${baseUrl}/voila/static/voila.js`]);
  const kernel = await voila.connectKernel(baseUrl, kernelid);
  /* eslint-disable camelcase, no-underscore-dangle */
  kernel._kernelSession = '_RESTARTING_';

  const widgetManager = getWidgetManager(voila, kernel);
  removeExtensionLoading(widgetManager);

  await widgetManager._build_models();

  const foundWidgets = {};

  await Promise.all(Object.values(widgetManager._models)
    .map(async (modelPromise) => {
      const model = await modelPromise;
      const meta = model.get('_metadata');
      const mountId = meta && meta.mount_id;
      if (mountId) {
        foundWidgets[mountId] = model;
      }
    }));
  /* eslint-disable camelcase, no-underscore-dangle */

  Object.entries(foundWidgets)
    .forEach(
      ([mountId, model]) => provideWidget({ mountId }, model),
    );
}
