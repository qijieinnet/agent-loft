// 照片（PhotoKit），只读：列相册、按条件找照片、取缩略图、导出原图。不删、不改。
import AppKit
import CoreLocation
import Foundation
import Photos

func photosStatusName() -> String {
    switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "fullAccess"
    case .limited: return "limited"
    @unknown default: return "unknown"
    }
}

@discardableResult
func requestPhotos() -> String {
    if PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined {
        let sem = DispatchSemaphore(value: 0)
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in sem.signal() }
        sem.wait()
    }
    return photosStatusName()
}

func requirePhotos() {
    let s = requestPhotos()
    if s == "fullAccess" || s == "limited" { return }
    fail("Photos access is \(s). Ask the user to open Agent Loft → 设置 → 苹果应用 and authorize 照片.")
}

// MARK: - 相册

func collectionDict(_ c: PHAssetCollection, kind: String) -> [String: Any] {
    ["id": c.localIdentifier, "title": c.localizedTitle ?? "", "kind": kind, "count": PHAsset.fetchAssets(in: c, options: nil).count]
}

func cmdPhotosAlbums() {
    var out: [[String: Any]] = []
    PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil).enumerateObjects { c, _, _ in
        out.append(collectionDict(c, kind: "album"))
    }
    // 智能相册只列有内容的（个人收藏、视频、自拍、截屏……）
    PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .any, options: nil).enumerateObjects { c, _, _ in
        let d = collectionDict(c, kind: "smart")
        if (d["count"] as? Int ?? 0) > 0 && c.assetCollectionSubtype != .smartAlbumAllHidden { out.append(d) }
    }
    output(out)
}

func findCollection(_ s: String) -> PHAssetCollection {
    let byId = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [s], options: nil)
    if let c = byId.firstObject { return c }
    var matches: [PHAssetCollection] = []
    for type in [PHAssetCollectionType.album, .smartAlbum] {
        PHAssetCollection.fetchAssetCollections(with: type, subtype: .any, options: nil).enumerateObjects { c, _, _ in
            if c.localizedTitle == s { matches.append(c) }
        }
    }
    if matches.count == 1 { return matches[0] }
    if matches.count > 1 { fail("several albums named '\(s)'; pass the id instead: " + matches.map(\.localIdentifier).joined(separator: ", ")) }
    fail("album '\(s)' not found")
}

// MARK: - 照片

let isoDay = makeFormatter("yyyy-MM-dd")

func assetDict(_ a: PHAsset) -> [String: Any] {
    var d: [String: Any] = [
        "id": a.localIdentifier,
        "date": fmt(a.creationDate),
        "type": a.mediaType == .video ? "video" : a.mediaType == .audio ? "audio" : "image",
        "width": a.pixelWidth,
        "height": a.pixelHeight,
        "favorite": a.isFavorite,
    ]
    if a.mediaType == .video { d["durationSeconds"] = Int(a.duration.rounded()) }
    if let loc = a.location {
        d["location"] = ["latitude": (loc.coordinate.latitude * 1e5).rounded() / 1e5, "longitude": (loc.coordinate.longitude * 1e5).rounded() / 1e5]
    }
    if let r = PHAssetResource.assetResources(for: a).first { d["filename"] = r.originalFilename }
    if a.mediaSubtypes.contains(.photoScreenshot) { d["screenshot"] = true }
    if a.mediaSubtypes.contains(.photoLive) { d["live"] = true }
    return d
}

func cmdPhotosSearch() {
    let fo = PHFetchOptions()
    var preds: [NSPredicate] = []
    if let f = opts["from"] { preds.append(NSPredicate(format: "creationDate >= %@", parseDate(f).0 as NSDate)) }
    if let t = opts["to"] {
        let (d, hasTime) = parseDate(t)
        preds.append(NSPredicate(format: "creationDate < %@", (hasTime ? d : cal.date(byAdding: .day, value: 1, to: d)!) as NSDate))
    }
    switch opts["type"] {
    case nil, "all": break
    case "image": preds.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue))
    case "video": preds.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.video.rawValue))
    default: fail("--type must be image, video or all")
    }
    if boolOpt("favorite") == true { preds.append(NSPredicate(format: "favorite == YES")) }
    if !preds.isEmpty { fo.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: preds) }
    let oldest = opts["order"] == "oldest"
    fo.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: oldest)]

    let result: PHFetchResult<PHAsset> = opts["album"].map { PHAsset.fetchAssets(in: findCollection($0), options: fo) } ?? PHAsset.fetchAssets(with: fo)

    // 地点：--near 纬度,经度，--radius 公里（默认 1）
    var near: CLLocation? = nil
    if let n = opts["near"] {
        let p = n.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard p.count == 2 else { fail("--near must be 'latitude,longitude'") }
        near = CLLocation(latitude: p[0], longitude: p[1])
    }
    let radius = (opts["radius"].flatMap(Double.init) ?? 1) * 1000
    let offset = max(0, opts["offset"].flatMap(Int.init) ?? 0)
    let lim = min(200, opts["limit"].flatMap(Int.init) ?? 50)

    var out: [[String: Any]] = []
    var matched = 0
    result.enumerateObjects { a, _, stop in
        if let near, !(a.location.map { $0.distance(from: near) <= radius } ?? false) { return }
        matched += 1
        if matched <= offset { return }
        out.append(assetDict(a))
        if out.count >= lim { stop.pointee = true }
    }
    var res: [String: Any] = ["count": out.count, "offset": offset, "photos": out]
    // 没按地点筛时总数是现成的
    if near == nil { res["total"] = result.count }
    output(res)
}

func assets(_ ids: [String]) -> [PHAsset] {
    let r = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
    var out: [PHAsset] = []
    r.enumerateObjects { a, _, _ in out.append(a) }
    let missing = Set(ids).subtracting(out.map(\.localIdentifier))
    if !missing.isEmpty { fail("photo not found: " + missing.sorted().joined(separator: ", ")) }
    return out
}

func idList() -> [String] {
    guard let raw = opts["ids"] ?? opts["id"] else { fail("--ids is required") }
    if let d = raw.data(using: .utf8), let arr = try? JSONSerialization.jsonObject(with: d) as? [String] { return arr }
    return raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}

/// 缩略图：JPEG，base64 放在 JSON 里（桌面端的 MCP 把它变成图片内容给智能体看）
func cmdPhotosThumbnails() {
    let ids = idList()
    if ids.count > 10 { fail("at most 10 photos at a time") }
    let size = CGFloat(min(1024, max(64, opts["size"].flatMap(Int.init) ?? 512)))
    let opt = PHImageRequestOptions()
    opt.isSynchronous = true
    opt.deliveryMode = .highQualityFormat
    opt.resizeMode = .fast
    opt.isNetworkAccessAllowed = true  // 原图在 iCloud 上时也取得到
    var out: [[String: Any]] = []
    for a in assets(ids) {
        var img: NSImage?
        PHImageManager.default().requestImage(for: a, targetSize: CGSize(width: size, height: size), contentMode: .aspectFit, options: opt) { i, _ in img = i }
        guard let img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
            out.append(["id": a.localIdentifier, "error": "cannot render thumbnail"])
            continue
        }
        out.append(["id": a.localIdentifier, "date": fmt(a.creationDate), "mimeType": "image/jpeg", "data": jpg.base64EncodedString()])
    }
    output(["thumbnails": out])
}

/// 导出原图 / 原视频到这台 Mac 上的一个目录（iCloud 上的会先下载）
func cmdPhotosExport() {
    let ids = idList()
    if ids.count > 200 { fail("at most 200 photos at a time") }
    guard let outDir = opts["out"] else { fail("--out is required") }
    let dir = URL(fileURLWithPath: (outDir as NSString).expandingTildeInPath)
    do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) } catch { fail("cannot create \(dir.path): \(error.localizedDescription)") }
    var out: [[String: Any]] = []
    for a in assets(ids) {
        let resources = PHAssetResource.assetResources(for: a)
        guard let r = resources.first(where: { $0.type == .photo || $0.type == .video }) ?? resources.first else {
            out.append(["id": a.localIdentifier, "error": "no resource"]); continue
        }
        var target = dir.appendingPathComponent(r.originalFilename)
        var n = 1
        while FileManager.default.fileExists(atPath: target.path) {
            let base = (r.originalFilename as NSString).deletingPathExtension, ext = (r.originalFilename as NSString).pathExtension
            target = dir.appendingPathComponent("\(base) (\(n))\(ext.isEmpty ? "" : ".\(ext)")"); n += 1
        }
        let o = PHAssetResourceRequestOptions()
        o.isNetworkAccessAllowed = true
        let sem = DispatchSemaphore(value: 0)
        var err: Error?
        PHAssetResourceManager.default().writeData(for: r, toFile: target, options: o) { e in err = e; sem.signal() }
        sem.wait()
        if let err { out.append(["id": a.localIdentifier, "error": err.localizedDescription]) }
        else { out.append(["id": a.localIdentifier, "file": target.path]) }
    }
    output(["action": "exported", "dir": dir.path, "files": out])
}
