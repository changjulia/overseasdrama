migrate(app => {
  app.save(new Collection({name:"script_semantic_results",type:"base",listRule:null,viewRule:null,createRule:null,updateRule:null,deleteRule:null,
    fields:[
      {type:"text",name:"source_key",required:true,max:100},
      {type:"text",name:"source_fingerprint",required:true,max:64},
      {type:"text",name:"cache_key",required:true,max:64},
      {type:"text",name:"result_hash",required:true,max:64},
      {type:"select",name:"state",values:["extracted_pending_video"],required:true,maxSelect:1},
      {type:"json",name:"identity",maxSize:20000},
      {type:"json",name:"result",maxSize:2000000},
      {type:"json",name:"provenance",maxSize:20000},
      {type:"autodate",name:"created",onCreate:true,onUpdate:false},
      {type:"autodate",name:"updated",onCreate:true,onUpdate:true}
    ],indexes:["CREATE UNIQUE INDEX idx_semantic_version ON script_semantic_results (source_key, source_fingerprint, cache_key)","CREATE INDEX idx_semantic_source ON script_semantic_results (source_key, created)"]}));
}, app => {throw new Error("Export derived semantic records before an explicit rollback; automatic deletion is disabled");});
