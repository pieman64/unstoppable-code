# Run with the Ruby environment used by CocoaPods: ruby test/podfile_test.rb
require 'cocoapods'
require 'tmpdir'

podfile_path = Pathname(File.expand_path('../Podfile', __dir__))
podfile = Pod::Podfile.from_file(podfile_path)

Dir.mktmpdir('mobile-podfile-test') do |directory|
  project = Xcodeproj::Project.new(File.join(directory, 'Pods.xcodeproj'))
  cases = {
    'LegacyShim' => ['13.0', '15.0'],
    'CurrentPlugin' => ['15.0', '15.0'],
    'NewerPlugin' => ['16.0', '16.0'],
  }
  cases.each do |name, (minimum, _expected)|
    target = project.new_target(:static_library, name, :ios, minimum)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum
    end
  end

  podfile.post_install!(Struct.new(:pods_project).new(project))

  project.targets.each do |target|
    expected = cases.fetch(target.name).last
    target.build_configurations.each do |config|
      actual = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
      unless actual == expected
        abort "#{target.name} #{config.name}: expected iOS #{expected}, got #{actual}"
      end
    end
  end
end

puts 'Pod deployment targets: legacy raised, current and newer preserved'
