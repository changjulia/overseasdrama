migrate(app=>app.save(new Collection({name:'script_semantic_matches',type:'base',listRule:null,viewRule:null,createRule:null,updateRule:null,deleteRule:null,
  fields:[{type:'text',name:'pair_key',required:true,max:64},{type:'text',name:'input_version',required:true,max:64},{type:'text',name:'model',required:true,max:100},{type:'text',name:'prompt_version',required:true,max:100},{type:'json',name:'result',maxSize:1000000},{type:'json',name:'provenance',maxSize:20000},{type:'autodate',name:'created',onCreate:true,onUpdate:false}],
  indexes:['CREATE UNIQUE INDEX idx_semantic_pair ON script_semantic_matches (pair_key, input_version, model, prompt_version)']
})),()=>{throw new Error('Export semantic matches before an explicit rollback');});
