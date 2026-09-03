migrate(app => {
  app.save(new Collection({name:"script_hook_decisions",type:"base",listRule:null,viewRule:null,createRule:null,updateRule:null,deleteRule:null,
    fields:[
      {type:"text",name:"decision_key",required:true,max:64},
      {type:"relation",name:"material",collectionId:app.findCollectionByNameOrId("ad_materials").id,maxSelect:1,required:true,cascadeDelete:true},
      {type:"relation",name:"highlight",collectionId:app.findCollectionByNameOrId("hook_assets").id,maxSelect:1,required:true,cascadeDelete:true},
      {type:"number",name:"scene_index",onlyInt:true,min:0},
      {type:"select",name:"state",values:["shortlist","reject","confirmed"],maxSelect:1,required:true},
      {type:"text",name:"input_version",required:true,max:64},
      {type:"json",name:"context",maxSize:2000000},
      {type:"json",name:"history",maxSize:10000000},
      {type:"autodate",name:"created",onCreate:true,onUpdate:false},
      {type:"autodate",name:"updated",onCreate:true,onUpdate:true}
    ],indexes:["CREATE UNIQUE INDEX idx_script_hook_decision ON script_hook_decisions (decision_key)"]}));
}, app => app.delete(app.findCollectionByNameOrId("script_hook_decisions")));
