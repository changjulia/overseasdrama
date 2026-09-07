/** Source attribution and edit usage are independent. Drafts may be matched. */
export function isPreRollSource(sourceClass?: string, usageRole?: string): boolean {
  return sourceClass === "external_material" || (sourceClass === "narration_opening" && usageRole === "pre_roll");
}

export const PRE_ROLL_FILTER = '(source_class="external_material" || (source_class="narration_opening" && usage_role="pre_roll"))';
