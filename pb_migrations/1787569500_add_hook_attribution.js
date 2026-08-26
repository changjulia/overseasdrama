/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const hooks = app.findCollectionByNameOrId("hook_assets");
  hooks.fields.add(new SelectField({
    name: "hook_source_status",
    maxSelect: 1,
    values: ["无独立钩子", "已确认同剧", "疑似外搭", "已确认外搭", "来源未知"]
  }));
  hooks.fields.add(new SelectField({
    name: "hook_assembly_type",
    maxSelect: 1,
    values: ["无前置钩子", "同剧外搭", "跨剧外搭", "外搭来源待确认"]
  }));
  return app.save(hooks);
}, (app) => {
  const hooks = app.findCollectionByNameOrId("hook_assets");
  hooks.fields.removeById(hooks.fields.getByName("hook_source_status").id);
  hooks.fields.removeById(hooks.fields.getByName("hook_assembly_type").id);
  return app.save(hooks);
});
