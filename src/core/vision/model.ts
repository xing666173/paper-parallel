/**
 * Formal source-layout analysis and final PDF review are intentionally pinned
 * to one verified multimodal model.  The user-selected model remains a text
 * translation concern and must never silently change this quality boundary.
 */
export const REQUIRED_VISION_MODEL_ID = 'deepseek-v4-flash-vision-exp' as const;
export const REQUIRED_VISION_MODEL_LABEL = 'DeepSeek V4 Flash Vision（实验）' as const;
