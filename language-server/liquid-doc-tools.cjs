'use strict';

let tools;

function liquidDocTools() {
  if (!tools) {
    let module;
    try {
      module = require('@shopify/theme-language-server-common/dist/utils/liquidDoc');
    } catch (error) {
      throw new Error(
        `Shopify LiquidDoc compatibility module is unavailable: ${error.message}`,
        { cause: error },
      );
    }
    if (
      typeof module.formatLiquidDocTagHandle !== 'function' ||
      !module.SUPPORTED_LIQUID_DOC_TAG_HANDLES
    ) {
      throw new Error(
        'Shopify LiquidDoc compatibility module does not expose the expected API',
      );
    }
    tools = module;
  }
  return tools;
}

module.exports = { liquidDocTools };
