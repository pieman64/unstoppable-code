import FirebaseCore
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    if FirebaseApp.app() == nil, FirebaseOptions.defaultOptions() != nil {
      FirebaseApp.configure()
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "FoldRegionsPlugin") {
      FoldRegionsPlugin.register(with: registrar)
    }
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "TranscriptCacheProtection") {
      TranscriptCacheProtection.register(with: registrar.messenger())
    }
  }
}

/// Complete data protection for the Remote Control transcript cache
/// (CAN-3373). Files created inside a protected directory inherit its
/// class, so cached transcripts are unreadable while the device is locked.
enum TranscriptCacheProtection {
  static let channelName = "com.unstoppabledomains.canopy/file_protection"

  private static let queue = DispatchQueue(
    label: "com.unstoppabledomains.canopy.file-protection",
    qos: .utility
  )

  static func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "protectDirectory" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard let arguments = call.arguments as? [String: Any],
        let path = arguments["path"] as? String
      else {
        result(FlutterError(code: "INVALID_ARGUMENTS", message: nil, details: nil))
        return
      }
      queue.async {
        let protected = (try? protectDirectory(atPath: path)) ?? false
        DispatchQueue.main.async { result(protected) }
      }
    }
  }

  /// Creates the directory at [path] inside Application Support if needed,
  /// applies Complete protection to it and to anything already inside, and
  /// reports whether the directory now carries it. Paths elsewhere throw.
  static func protectDirectory(
    atPath path: String,
    fileManager: FileManager = .default
  ) throws -> Bool {
    let support = try fileManager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    ).standardizedFileURL.path
    let directory = URL(fileURLWithPath: path).standardizedFileURL.path
    guard directory.hasPrefix(support + "/") else {
      throw CocoaError(.fileWriteNoPermission)
    }
    let complete = [FileAttributeKey.protectionKey: FileProtectionType.complete]
    try fileManager.createDirectory(
      atPath: directory,
      withIntermediateDirectories: true,
      attributes: complete
    )
    try fileManager.setAttributes(complete, ofItemAtPath: directory)
    for name in try fileManager.contentsOfDirectory(atPath: directory) {
      try fileManager.setAttributes(
        complete,
        ofItemAtPath: (directory as NSString).appendingPathComponent(name)
      )
    }
    let protection = try fileManager.attributesOfItem(atPath: directory)[.protectionKey]
    return protection as? FileProtectionType == .complete
  }
}
