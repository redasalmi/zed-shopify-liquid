'use strict';

let tools;

function liquidDocTools() {
  if (!tools) {
    try {
      tools = require('@shopify/theme-language-server-common/dist/utils/liquidDoc');
    } catch (error) {
      throw new Error(
        `Shopify LiquidDoc compatibility module is unavailable: ${error.message}`,
        { cause: error },
      );
    }
    if (
      typeof tools.formatLiquidDocTagHandle !== 'function' ||
      !tools.SUPPORTED_LIQUID_DOC_TAG_HANDLES
    ) {
      throw new Error(
        'Shopify LiquidDoc compatibility module does not expose the expected API',
      );
    }
  }
  return tools;
}

module.exports = { liquidDocTools };
