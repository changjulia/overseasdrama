/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("ad_materials");
  const video = collection.fields.getByName("video");
  video.mimeTypes = [
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-matroska",
    "video/x-msvideo",
    "video/mpeg",
  ];
  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("ad_materials");
  const video = collection.fields.getByName("video");
  video.mimeTypes = [];
  return app.save(collection);
});
