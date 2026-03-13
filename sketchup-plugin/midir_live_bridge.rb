require 'sketchup.rb'
require 'extensions.rb'

module MidirTools
  module LiveBridge

    PLUGIN_ID = "midir_live_bridge".freeze
    PLUGIN_NAME = "3D Converter Bridge".freeze
    PLUGIN_VERSION = "1.0".freeze
    PLUGIN_DESCRIPTION = "Live verbinding tussen 3D Converter en SketchUp.".freeze

    file = __FILE__
    file = file.dup.force_encoding("UTF-8") if file.respond_to?(:force_encoding)
    PLUGIN_PATH = File.dirname(file).freeze

    unless file_loaded?(File.basename(__FILE__))
      extension = SketchupExtension.new(PLUGIN_NAME, File.join(PLUGIN_PATH, "midir_live_bridge", "main"))
      extension.version     = PLUGIN_VERSION
      extension.description = PLUGIN_DESCRIPTION
      extension.creator     = "Midir"
      extension.copyright   = "2026"

      Sketchup.register_extension(extension, true)
      file_loaded(File.basename(__FILE__))
    end

  end
end
