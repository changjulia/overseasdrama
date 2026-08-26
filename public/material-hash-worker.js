self.onmessage=async(event)=>{
  try{
    const file=event.data;
    const buffer=await file.arrayBuffer();
    const digest=await crypto.subtle.digest("SHA-256",buffer);
    const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
    self.postMessage({hash});
  }catch(error){self.postMessage({error:error instanceof Error?error.message:"hash failed"})}
};
