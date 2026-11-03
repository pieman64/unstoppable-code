import Flutter
import UIKit
import XCTest

@testable import Runner

class RunnerTests: XCTestCase {

  private func protection(of url: URL) throws -> FileProtectionType? {
    try FileManager.default.attributesOfItem(atPath: url.path)[.protectionKey]
      as? FileProtectionType
  }

  private func makeCacheDirectory() throws -> URL {
    let support = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    return support.appendingPathComponent("remote-transcripts-\(UUID().uuidString)")
  }

  /// CAN-3373: the directory and everything already inside it are asked for
  /// Complete protection, and success requires the directory to report it.
  func testTranscriptCacheProtectionRequestsCompleteForDirectoryAndContents() throws {
    let directory = try makeCacheDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let existing = directory.appendingPathComponent("chat.json")
    FileManager.default.createFile(atPath: existing.path, contents: Data("tail".utf8))
    let fileManager = RecordingFileManager(reportedProtection: .complete)

    XCTAssertTrue(
      try TranscriptCacheProtection.protectDirectory(
        atPath: directory.path,
        fileManager: fileManager
      )
    )

    XCTAssertEqual(fileManager.createdDirectoryProtection, .complete)
    XCTAssertEqual(
      fileManager.protectionRequests,
      [
        directory.standardizedFileURL.path: .complete,
        existing.standardizedFileURL.path: .complete,
      ]
    )
  }

  /// Without reported Complete protection the cache is not used, so nothing
  /// is written unprotected. The iOS Simulator reports no protection at all.
  func testTranscriptCacheProtectionFailsClosedWhenProtectionIsNotReported() throws {
    let directory = try makeCacheDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let fileManager = RecordingFileManager(reportedProtection: nil)

    XCTAssertFalse(
      try TranscriptCacheProtection.protectDirectory(
        atPath: directory.path,
        fileManager: fileManager
      )
    )
    XCTAssertEqual(fileManager.createdDirectoryProtection, .complete)
  }

  /// CAN-3373: the temp and final files of an atomic replacement inherit the
  /// directory's Complete protection. Only a device reports protection.
  func testTranscriptCacheFilesInheritCompleteProtection() throws {
    #if targetEnvironment(simulator)
      throw XCTSkip("The iOS Simulator does not report data protection; device only.")
    #else
      let directory = try makeCacheDirectory()
      defer { try? FileManager.default.removeItem(at: directory) }

      XCTAssertTrue(try TranscriptCacheProtection.protectDirectory(atPath: directory.path))
      XCTAssertEqual(try protection(of: directory), .complete)

      // The Dart writer creates `<name>.tmp` and renames it over `<name>`.
      let final = directory.appendingPathComponent("chat.json")
      let temp = directory.appendingPathComponent("chat.json.tmp")
      for revision in ["first", "second"] {
        FileManager.default.createFile(atPath: temp.path, contents: Data(revision.utf8))
        XCTAssertEqual(try protection(of: temp), .complete)
        // POSIX rename, as Dart's File.rename does.
        XCTAssertEqual(rename(temp.path, final.path), 0)
        XCTAssertEqual(try protection(of: final), .complete)
      }
      XCTAssertEqual(try String(contentsOf: final, encoding: .utf8), "second")

      // Protecting again keeps working over existing contents.
      XCTAssertTrue(try TranscriptCacheProtection.protectDirectory(atPath: directory.path))
    #endif
  }

  func testTranscriptCacheProtectionRejectsPathsOutsideApplicationSupport() {
    let outside = FileManager.default.temporaryDirectory
      .appendingPathComponent("remote-transcripts-\(UUID().uuidString)")
    XCTAssertThrowsError(try TranscriptCacheProtection.protectDirectory(atPath: outside.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: outside.path))
  }

}

/// Performs real file operations, records the protection each one asks for,
/// and reports [reportedProtection] for every item.
private final class RecordingFileManager: FileManager {
  private let reportedProtection: FileProtectionType?
  private(set) var createdDirectoryProtection: FileProtectionType?
  private(set) var protectionRequests: [String: FileProtectionType] = [:]

  init(reportedProtection: FileProtectionType?) {
    self.reportedProtection = reportedProtection
    super.init()
  }

  override func createDirectory(
    atPath path: String,
    withIntermediateDirectories createIntermediates: Bool,
    attributes: [FileAttributeKey: Any]? = nil
  ) throws {
    createdDirectoryProtection = attributes?[.protectionKey] as? FileProtectionType
    try super.createDirectory(
      atPath: path,
      withIntermediateDirectories: createIntermediates,
      attributes: attributes
    )
  }

  override func setAttributes(
    _ attributes: [FileAttributeKey: Any],
    ofItemAtPath path: String
  ) throws {
    protectionRequests[URL(fileURLWithPath: path).standardizedFileURL.path] =
      attributes[.protectionKey] as? FileProtectionType
    try super.setAttributes(attributes, ofItemAtPath: path)
  }

  override func attributesOfItem(atPath path: String) throws -> [FileAttributeKey: Any] {
    var attributes = try super.attributesOfItem(atPath: path)
    attributes[.protectionKey] = reportedProtection
    return attributes
  }
}
