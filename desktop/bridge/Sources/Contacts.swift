// 通讯录（Contacts 框架）。备注字段要苹果特批的权限，读写不了，不碰。
import Contacts
import Foundation

let contactStore = CNContactStore()

func contactsStatusName() -> String {
    switch CNContactStore.authorizationStatus(for: .contacts).rawValue {
    case 0: return "notDetermined"
    case 1: return "restricted"
    case 2: return "denied"
    case 3: return "fullAccess"
    case 4: return "limited"  // macOS 15 起：只给了部分联系人
    default: return "unknown"
    }
}

@discardableResult
func requestContacts() -> String {
    if CNContactStore.authorizationStatus(for: .contacts) == .notDetermined {
        let sem = DispatchSemaphore(value: 0)
        contactStore.requestAccess(for: .contacts) { _, _ in sem.signal() }
        sem.wait()
    }
    return contactsStatusName()
}

func requireContacts() {
    let s = requestContacts()
    if s == "fullAccess" || s == "limited" { return }
    fail("Contacts access is \(s). Ask the user to open Agent Loft → 设置 → 苹果应用 and authorize 通讯录.")
}

let contactKeys: [CNKeyDescriptor] = [
    CNContactIdentifierKey, CNContactTypeKey, CNContactGivenNameKey, CNContactFamilyNameKey, CNContactMiddleNameKey,
    CNContactNicknameKey, CNContactOrganizationNameKey, CNContactDepartmentNameKey, CNContactJobTitleKey,
    CNContactPhoneNumbersKey, CNContactEmailAddressesKey, CNContactPostalAddressesKey, CNContactBirthdayKey,
    CNContactUrlAddressesKey, CNContactDatesKey,
].map { $0 as CNKeyDescriptor } + [CNContactFormatter.descriptorForRequiredKeys(for: .fullName)]

func label(_ l: String?) -> String {
    guard let l else { return "" }
    return CNLabeledValue<NSString>.localizedString(forLabel: l)
}

func contactName(_ c: CNContact) -> String {
    let n = CNContactFormatter.string(from: c, style: .fullName) ?? ""
    return n.isEmpty ? c.organizationName : n
}

func contactDict(_ c: CNContact, full: Bool) -> [String: Any] {
    var d: [String: Any] = [
        "id": c.identifier,
        "name": contactName(c),
        "phones": c.phoneNumbers.map { ["label": label($0.label), "value": $0.value.stringValue] },
        "emails": c.emailAddresses.map { ["label": label($0.label), "value": $0.value as String] },
    ]
    if !c.organizationName.isEmpty { d["organization"] = c.organizationName }
    if !c.jobTitle.isEmpty { d["jobTitle"] = c.jobTitle }
    guard full else { return d }
    d["givenName"] = c.givenName
    d["familyName"] = c.familyName
    if !c.middleName.isEmpty { d["middleName"] = c.middleName }
    if !c.nickname.isEmpty { d["nickname"] = c.nickname }
    if !c.departmentName.isEmpty { d["department"] = c.departmentName }
    if let b = c.birthday {
        d["birthday"] = b.year.map { String(format: "%04d-%02d-%02d", $0, b.month ?? 0, b.day ?? 0) } ?? String(format: "--%02d-%02d", b.month ?? 0, b.day ?? 0)
    }
    if !c.postalAddresses.isEmpty {
        d["addresses"] = c.postalAddresses.map { a -> [String: String] in
            ["label": label(a.label), "value": CNPostalAddressFormatter.string(from: a.value, style: .mailingAddress).replacingOccurrences(of: "\n", with: ", ")]
        }
    }
    if !c.urlAddresses.isEmpty { d["urls"] = c.urlAddresses.map { ["label": label($0.label), "value": $0.value as String] } }
    return d
}

func cmdContactsSearch() {
    let q = (opts["query"] ?? "").trimmingCharacters(in: .whitespaces)
    var out: [CNContact] = []
    if q.isEmpty {
        let req = CNContactFetchRequest(keysToFetch: contactKeys)
        req.sortOrder = .userDefault
        try? contactStore.enumerateContacts(with: req) { c, _ in out.append(c) }
    } else {
        var seen = Set<String>()
        func add(_ list: [CNContact]) { for c in list where seen.insert(c.identifier).inserted { out.append(c) } }
        add((try? contactStore.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: q), keysToFetch: contactKeys)) ?? [])
        if q.contains("@") {
            add((try? contactStore.unifiedContacts(matching: CNContact.predicateForContacts(matchingEmailAddress: q), keysToFetch: contactKeys)) ?? [])
        }
        let digits = q.filter(\.isNumber)
        if digits.count >= 3 {
            // 号码按片段匹配：系统的号码谓词要整号，自己扫一遍
            let req = CNContactFetchRequest(keysToFetch: contactKeys)
            try? contactStore.enumerateContacts(with: req) { c, _ in
                if c.phoneNumbers.contains(where: { $0.value.stringValue.filter(\.isNumber).contains(digits) }) { add([c]) }
            }
        }
        // 公司名、邮箱片段
        let lq = q.lowercased()
        let req = CNContactFetchRequest(keysToFetch: contactKeys)
        try? contactStore.enumerateContacts(with: req) { c, _ in
            if c.organizationName.lowercased().contains(lq) || c.emailAddresses.contains(where: { ($0.value as String).lowercased().contains(lq) }) { add([c]) }
        }
    }
    let total = out.count
    let lim = opts["limit"].flatMap(Int.init) ?? 50
    output(["total": total, "contacts": out.prefix(lim).map { contactDict($0, full: false) }])
}

func findContact() -> CNContact {
    guard let id = opts["id"] else { fail("--id is required") }
    guard let c = try? contactStore.unifiedContact(withIdentifier: id, keysToFetch: contactKeys) else { fail("contact not found: \(id)") }
    return c
}

func cmdContactsGet() { output(contactDict(findContact(), full: true)) }

func cmdContactsGroups() {
    let groups = (try? contactStore.groups(matching: nil)) ?? []
    output(groups.map { ["id": $0.identifier, "name": $0.name] })
}

/// --phones / --emails / --urls 是 JSON 数组：[{"label":"mobile","value":"..."}] 或者直接 ["..."]
func labeledList(_ key: String) -> [(String, String)]? {
    guard let raw = opts[key] else { return nil }
    guard let data = raw.data(using: .utf8), let arr = try? JSONSerialization.jsonObject(with: data) as? [Any] else {
        fail("--\(key) must be a JSON array, e.g. [{\"label\":\"mobile\",\"value\":\"138...\"}]")
    }
    return arr.map { item in
        if let s = item as? String { return ("", s) }
        if let o = item as? [String: Any], let v = o["value"] as? String { return ((o["label"] as? String) ?? "", v) }
        fail("--\(key): each item needs a \"value\"")
    }
}

/// 常用标签认中英文，其他原样当自定义标签
func cnLabel(_ s: String, phone: Bool) -> String? {
    switch s.lowercased() {
    case "": return nil
    case "mobile", "手机": return phone ? CNLabelPhoneNumberMobile : CNLabelOther
    case "iphone": return CNLabelPhoneNumberiPhone
    case "main", "主要": return CNLabelPhoneNumberMain
    case "home", "住宅", "家": return CNLabelHome
    case "work", "工作", "公司": return CNLabelWork
    case "other", "其他": return CNLabelOther
    default: return s
    }
}

func parseBirthday(_ s: String) -> DateComponents? {
    if s == "none" || s.isEmpty { return nil }
    let parts = s.split(separator: "-").map(String.init)
    var dc = DateComponents()
    if parts.count == 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) { dc.year = y; dc.month = m; dc.day = d; return dc }
    if parts.count == 2, let m = Int(parts[0]), let d = Int(parts[1]) { dc.month = m; dc.day = d; return dc }
    fail("--birthday: YYYY-MM-DD or MM-DD (or none)")
}

func applyContactFields(_ c: CNMutableContact) {
    if let v = opts["given-name"] { c.givenName = v }
    if let v = opts["family-name"] { c.familyName = v }
    if let v = opts["nickname"] { c.nickname = v }
    if let v = opts["organization"] { c.organizationName = v }
    if let v = opts["job-title"] { c.jobTitle = v }
    if let v = opts["birthday"] { c.birthday = parseBirthday(v) }
    if let l = labeledList("phones") { c.phoneNumbers = l.map { CNLabeledValue(label: cnLabel($0.0, phone: true), value: CNPhoneNumber(stringValue: $0.1)) } }
    if let l = labeledList("emails") { c.emailAddresses = l.map { CNLabeledValue(label: cnLabel($0.0, phone: false), value: $0.1 as NSString) } }
    if let l = labeledList("urls") { c.urlAddresses = l.map { CNLabeledValue(label: cnLabel($0.0, phone: false), value: $0.1 as NSString) } }
}

func execute(_ req: CNSaveRequest) {
    do { try contactStore.execute(req) } catch { fail("save failed: \(error.localizedDescription)") }
}

func cmdContactsAdd() {
    if opts["given-name"] == nil && opts["family-name"] == nil && opts["organization"] == nil { fail("pass given_name, family_name or organization") }
    let c = CNMutableContact()
    applyContactFields(c)
    let req = CNSaveRequest()
    req.add(c, toContainerWithIdentifier: nil)
    execute(req)
    let saved = (try? contactStore.unifiedContact(withIdentifier: c.identifier, keysToFetch: contactKeys)) ?? c
    output(["action": "created", "contact": contactDict(saved, full: true)])
}

func cmdContactsUpdate() {
    let c = findContact()
    confirmWrite("修改联系人", "「\(contactName(c))」" + describeChanges(["given-name", "family-name", "nickname", "organization", "job-title", "birthday", "phones", "emails", "urls"]))
    let before = contactDict(c, full: true)
    guard let m = c.mutableCopy() as? CNMutableContact else { fail("cannot edit contact") }
    applyContactFields(m)
    let req = CNSaveRequest()
    req.update(m)
    execute(req)
    let after = (try? contactStore.unifiedContact(withIdentifier: c.identifier, keysToFetch: contactKeys)) ?? m
    output(["action": "updated", "before": before, "after": contactDict(after, full: true)])
}

func cmdContactsDelete() {
    let c = findContact()
    let phones = c.phoneNumbers.prefix(2).map { $0.value.stringValue }.joined(separator: "、")
    confirmWrite("删除联系人", "「\(contactName(c))」\(phones.isEmpty ? "" : "\n\(phones)")\n\n删了不能恢复，iCloud 上也会一起删掉。")
    let d = contactDict(c, full: true)
    guard let m = c.mutableCopy() as? CNMutableContact else { fail("cannot delete contact") }
    let req = CNSaveRequest()
    req.delete(m)
    execute(req)
    output(["action": "deleted", "contact": d])
}
