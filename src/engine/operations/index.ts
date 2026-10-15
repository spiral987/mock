// すべての操作ハンドラをレジストリに登録する。
// このモジュールを import すると副作用として登録が走る（applyOperation の前提）。
import { registerOp } from '../operation';
import { brushHandler } from './brush';
import { eraserHandler } from './eraser';
import { translateHandler } from './translate';
import { brightnessHandler } from './brightness';
import { hueHandler } from './hue';
import { addLayerHandler } from './addLayer';
import { addImageLayerHandler } from './addImageLayer';
import {
  setLayerVisibilityHandler,
  setLayerOpacityHandler,
  setLayerClippingHandler,
  setLayerBlendModeHandler,
  renameLayerHandler,
  removeLayerHandler,
  reorderLayerHandler,
  clearLayerHandler,
  mergeDownLayerHandler,
  moveNodeHandler,
  addGroupHandler,
  setGroupCollapsedHandler,
} from './layerOps';
import { fillHandler } from './fill';
import { lassoFillHandler } from './lassoFill';
import { setSelectionHandler, clearSelectionHandler } from './selectionOps';
import { transformHandler } from './transform';
import { baselineHandler } from './baseline';
import { canvasSizeHandler } from './canvasSize';
import {
  addVariantHandler,
  setVariantIndexHandler,
  removeVariantHandler,
  moveAsVariantHandler,
} from './variantOps';
import {
  addStateHandler,
  removeStateHandler,
  renameStateHandler,
  setAttachmentHandler,
  applyStateHandler,
} from './stateOps';

registerOp(brushHandler);
registerOp(eraserHandler);
registerOp(translateHandler);
registerOp(brightnessHandler);
registerOp(hueHandler);
registerOp(addLayerHandler);
registerOp(addImageLayerHandler);
registerOp(setLayerVisibilityHandler);
registerOp(setLayerOpacityHandler);
registerOp(setLayerClippingHandler);
registerOp(setLayerBlendModeHandler);
registerOp(renameLayerHandler);
registerOp(removeLayerHandler);
registerOp(reorderLayerHandler);
registerOp(clearLayerHandler);
registerOp(mergeDownLayerHandler);
registerOp(moveNodeHandler);
registerOp(addGroupHandler);
registerOp(setGroupCollapsedHandler);
registerOp(fillHandler);
registerOp(lassoFillHandler);
registerOp(setSelectionHandler);
registerOp(clearSelectionHandler);
registerOp(transformHandler);
registerOp(baselineHandler);
registerOp(canvasSizeHandler);
registerOp(addVariantHandler);
registerOp(setVariantIndexHandler);
registerOp(removeVariantHandler);
registerOp(moveAsVariantHandler);
registerOp(addStateHandler);
registerOp(removeStateHandler);
registerOp(renameStateHandler);
registerOp(setAttachmentHandler);
registerOp(applyStateHandler);

export { brushHandler, createBrushOp, type BrushParams } from './brush';
export { eraserHandler, createEraserOp, type EraserParams } from './eraser';
export { translateHandler, createTranslateOp, type TranslateParams } from './translate';
export { brightnessHandler, createBrightnessOp, type BrightnessParams } from './brightness';
export { hueHandler, createHueOp, type HueParams } from './hue';
export { addLayerHandler, createAddLayerOp, type AddLayerParams } from './addLayer';
export {
  addImageLayerHandler,
  createAddImageLayerOp,
  type AddImageLayerParams,
} from './addImageLayer';
export {
  createSetLayerVisibilityOp,
  createSetLayerOpacityOp,
  createSetLayerClippingOp,
  createSetLayerBlendModeOp,
  createRenameLayerOp,
  createRemoveLayerOp,
  createReorderLayerOp,
  createClearLayerOp,
  createMergeDownLayerOp,
  createMoveNodeOp,
  createAddGroupOp,
  createSetGroupCollapsedOp,
  type SetLayerVisibilityParams,
  type SetLayerOpacityParams,
  type SetLayerClippingParams,
  type SetLayerBlendModeParams,
  type RenameLayerParams,
  type RemoveLayerParams,
  type ReorderLayerParams,
  type ClearLayerParams,
  type MergeDownLayerParams,
  type MoveNodeParams,
  type AddGroupParams,
  type SetGroupCollapsedParams,
} from './layerOps';
export { fillHandler, createFillOp, fillRegion, type FillParams } from './fill';
export { lassoFillHandler, createLassoFillOp, type LassoFillParams } from './lassoFill';
export {
  setSelectionHandler,
  createSetSelectionOp,
  clearSelectionHandler,
  createClearSelectionOp,
  type SetSelectionParams,
} from './selectionOps';
export { transformHandler, createTransformOp, type TransformParams } from './transform';
export { baselineHandler, createBaselineOp, type BaselineParams } from './baseline';
export { canvasSizeHandler, createSetCanvasSizeOp, type CanvasSizeParams } from './canvasSize';
export {
  addVariantHandler,
  createAddVariantOp,
  setVariantIndexHandler,
  createSetVariantIndexOp,
  removeVariantHandler,
  createRemoveVariantOp,
  moveAsVariantHandler,
  createMoveAsVariantOp,
  type AddVariantParams,
  type SetVariantIndexParams,
  type RemoveVariantParams,
  type MoveAsVariantParams,
} from './variantOps';
export {
  addStateHandler,
  createAddStateOp,
  removeStateHandler,
  createRemoveStateOp,
  renameStateHandler,
  createRenameStateOp,
  setAttachmentHandler,
  createSetAttachmentOp,
  applyStateHandler,
  createApplyStateOp,
  type AddStateParams,
  type RemoveStateParams,
  type RenameStateParams,
  type SetAttachmentParams,
  type ApplyStateParams,
} from './stateOps';
