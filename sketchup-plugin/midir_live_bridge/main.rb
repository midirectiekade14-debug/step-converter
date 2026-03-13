require 'socket'
require 'json'

module MidirTools
  module LiveBridge

    BRIDGE_PORT = 7891
    MY_PATH = File.dirname(__FILE__).freeze

    @server = nil
    @timer = nil
    @running = false

    # ── OBJ Parser ──────────────────────────────────────────────────────────

    def self.parse_obj(text)
      vertices = []
      objects = []
      current = { name: "default", faces: [], mtl: nil }
      colors = {}   # material -> [r,g,b]
      current_mtl = nil

      text.each_line do |line|
        line = line.strip
        next if line.empty?

        # Inline kleur: #!color <name> <r> <g> <b>
        if line.start_with?("#!color ")
          parts = line.split
          if parts.length >= 5
            colors[parts[1]] = [parts[2].to_i, parts[3].to_i, parts[4].to_i]
          end
          next
        end
        next if line.start_with?("#")

        parts = line.split
        case parts[0]
        when "v"
          vertices << [parts[1].to_f, parts[2].to_f, parts[3].to_f] if parts.length >= 4
        when "f"
          face = parts[1..].map { |p| p.split("/")[0].to_i }
          face.map! { |vi| vi < 0 ? vertices.length + vi + 1 : vi }
          current[:faces] << face if face.length >= 3
        when "o", "g"
          if current[:faces].any?
            objects << current
          end
          name = parts[1..].join(" ")
          name = "object_#{objects.length}" if name.empty?
          current = { name: name, faces: [], mtl: nil }
        when "usemtl"
          current_mtl = parts[1..].join(" ")
          current[:mtl] = current_mtl
        end
      end
      objects << current if current[:faces].any?

      { vertices: vertices, objects: objects, colors: colors }
    end

    # ── Build geometry in SketchUp ────────────────────────────────────────

    def self.build_model(data, model_name = "Import")
      model = Sketchup.active_model
      model.start_operation("Live Import: #{model_name}", true)

      parsed = parse_obj(data)
      vertices = parsed[:vertices]
      objects = parsed[:objects]
      colors = parsed[:colors]

      total_faces = 0
      total_ok = 0

      objects.each do |obj|
        grp = model.active_entities.add_group
        grp.name = obj[:name]
        ents = grp.entities

        # Materiaal
        mat_name = obj[:mtl] || obj[:name]
        if colors[mat_name]
          r, g, b = colors[mat_name]
          mat = model.materials.add(mat_name)
          mat.color = Sketchup::Color.new(r, g, b)
          grp.material = mat
        end

        # Mesh via PolygonMesh (veel sneller dan add_face per stuk)
        used_verts = {}
        obj[:faces].each { |f| f.each { |vi| used_verts[vi] = true } }

        mesh = Geom::PolygonMesh.new(used_verts.size, obj[:faces].size)
        vert_map = {}

        used_verts.keys.sort.each do |vi|
          next unless vi >= 1 && vi <= vertices.length
          x, y, z = vertices[vi - 1]
          # mm -> inches
          idx = mesh.add_point(Geom::Point3d.new(x / 25.4, y / 25.4, z / 25.4))
          vert_map[vi] = idx
        end

        obj[:faces].each do |face|
          total_faces += 1
          begin
            pts = face.map { |vi| vert_map[vi] }.compact
            if pts.length >= 3
              mesh.add_polygon(*pts)
              total_ok += 1
            end
          rescue => e
            puts "Face overgeslagen: #{e.message}"
          end
        end

        ents.fill_from_mesh(mesh, true, Geom::PolygonMesh::AUTO_SOFTEN) if mesh.count_polygons > 0
      end

      model.commit_operation
      model.active_view.zoom_extents

      msg = "Live Import: #{objects.length} groepen, #{total_ok}/#{total_faces} faces"
      puts msg
      Sketchup.status_text = msg
      { ok: true, groups: objects.length, faces_ok: total_ok, faces_total: total_faces }
    end

    # ── Export SketchUp model als OBJ ─────────────────────────────────────

    def self.export_obj
      model = Sketchup.active_model
      entities = model.active_entities
      obj = "# SketchUp Live Export\n"

      vert_offset = 0
      entities.each_with_index do |ent, gi|
        next unless ent.is_a?(Sketchup::Group) || ent.is_a?(Sketchup::ComponentInstance)

        name = ent.respond_to?(:name) && !ent.name.empty? ? ent.name : "Object_#{gi}"
        name = name.gsub(/\s+/, '_')

        # Kleur
        if ent.material && ent.material.color
          c = ent.material.color
          obj << "#!color #{name} #{c.red} #{c.green} #{c.blue}\n"
        end

        ents = ent.is_a?(Sketchup::Group) ? ent.entities : ent.definition.entities
        transform = ent.transformation

        obj << "o #{name}\nusemtl #{name}\n"

        # Verzamel alle faces
        faces = ents.grep(Sketchup::Face)
        vert_map = {}
        local_idx = 0

        faces.each do |face|
          face.vertices.each do |v|
            vid = v.entityID
            unless vert_map[vid]
              pt = v.position.transform(transform)
              # inches -> mm
              obj << "v #{(pt.x * 25.4).round(6)} #{(pt.y * 25.4).round(6)} #{(pt.z * 25.4).round(6)}\n"
              local_idx += 1
              vert_map[vid] = local_idx + vert_offset
            end
          end
        end

        faces.each do |face|
          indices = face.vertices.map { |v| vert_map[v.entityID] }
          obj << "f #{indices.join(' ')}\n"
        end

        vert_offset += local_idx
        obj << "\n"
      end

      obj
    end

    # ── TCP Server ────────────────────────────────────────────────────────

    def self.start_server
      return if @running

      begin
        @server = TCPServer.new("127.0.0.1", BRIDGE_PORT)
        @server.setsockopt(Socket::SOL_SOCKET, Socket::SO_REUSEADDR, true)
        @running = true
        @pending = []

        puts "=" * 50
        puts "  Live Bridge actief op poort #{BRIDGE_PORT}"
        puts "=" * 50

        # Poll elke 100ms voor inkomende verbindingen (main thread!)
        @timer = UI.start_timer(0.1, true) do
          check_connections
        end

        Sketchup.status_text = "Live Bridge: actief op poort #{BRIDGE_PORT}"
      rescue => e
        puts "Live Bridge FOUT: #{e.message}"
        UI.messagebox("Kan Live Bridge niet starten:\n#{e.message}")
      end
    end

    def self.stop_server
      return unless @running

      UI.stop_timer(@timer) if @timer
      @timer = nil
      @server.close if @server && !@server.closed?
      @server = nil
      @running = false
      Sketchup.status_text = "Live Bridge: gestopt"
      puts "Live Bridge gestopt"
    end

    def self.check_connections
      return unless @server && !@server.closed?

      begin
        client = @server.accept_nonblock
        Thread.new(client) do |c|
          handle_client(c)
        end
      rescue IO::WaitReadable, Errno::EWOULDBLOCK
        # Geen verbinding — prima
      rescue => e
        puts "Bridge accept fout: #{e.message}"
      end
    end

    def self.handle_client(client)
      begin
        request = ""
        while (line = client.gets)
          request << line
          break if line.strip.empty?
        end

        method, path, _ = request.lines.first&.split
        headers = {}
        request.lines[1..].each do |h|
          break if h.strip.empty?
          key, val = h.split(": ", 2)
          headers[key&.downcase] = val&.strip
        end

        content_length = (headers["content-length"] || 0).to_i
        body = content_length > 0 ? client.read([content_length, 100_000_000].min) : ""

        case "#{method} #{path}"
        when "GET /status"
          respond(client, 200, { status: "ok", sketchup: Sketchup.version, bridge: "1.0" }.to_json)

        when "POST /import"
          # Ontvang OBJ data, bouw in SketchUp (moet op main thread!)
          @pending << { type: :import, data: body, client: client }
          # Timer pikt dit op
          return  # client pas sluiten na response

        when "GET /export"
          # Exporteer huidig model als OBJ
          @pending << { type: :export, client: client }
          return

        when "OPTIONS /"
          respond(client, 200, "")

        else
          respond(client, 404, '{"error":"Onbekend endpoint"}')
        end
      rescue => e
        puts "Bridge client fout: #{e.message}"
        respond(client, 500, %({"error":"#{e.message}"})) rescue nil
      ensure
        client.close rescue nil unless @pending&.any? { |p| p[:client] == client }
      end
    end

    # Timer callback verwerkt pending requests op main thread
    original_check = instance_method(:check_connections)
    define_method(:check_connections) do
      # Handled by timer
    end

    # Override check_connections to also process pending
    def self.check_connections
      return unless @server && !@server.closed?

      # Accept new connections
      begin
        client = @server.accept_nonblock
        Thread.new(client) { |c| handle_client(c) }
      rescue IO::WaitReadable, Errno::EWOULDBLOCK
      rescue => e
        puts "Bridge accept fout: #{e.message}"
      end

      # Process pending (op main thread = veilig voor SketchUp API)
      while (job = @pending&.shift)
        begin
          case job[:type]
          when :import
            result = build_model(job[:data])
            respond(job[:client], 200, result.to_json)
          when :export
            obj_data = export_obj
            respond(job[:client], 200, obj_data, "text/plain")
          end
        rescue => e
          respond(job[:client], 500, %({"error":"#{e.message}"})) rescue nil
        ensure
          job[:client].close rescue nil
        end
      end
    end

    def self.respond(client, code, body, content_type = "application/json")
      status = { 200 => "OK", 404 => "Not Found", 500 => "Internal Server Error" }
      client.print "HTTP/1.1 #{code} #{status[code]}\r\n"
      client.print "Content-Type: #{content_type}\r\n"
      client.print "Content-Length: #{body.bytesize}\r\n"
      client.print "Access-Control-Allow-Origin: *\r\n"
      client.print "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
      client.print "Access-Control-Allow-Headers: Content-Type\r\n"
      client.print "Connection: close\r\n"
      client.print "\r\n"
      client.print body
    rescue => e
      puts "Bridge response fout: #{e.message}"
    end

    # ── Menu ──────────────────────────────────────────────────────────────

    unless @menu_loaded
      menu = UI.menu("Plugins")
      submenu = menu.add_submenu("Live Bridge")

      submenu.add_item("Start Bridge") { start_server }
      submenu.add_item("Stop Bridge") { stop_server }
      submenu.add_separator
      submenu.add_item("Status") do
        if @running
          UI.messagebox("Live Bridge draait op poort #{BRIDGE_PORT}")
        else
          UI.messagebox("Live Bridge is niet actief.\nStart via Plugins > Live Bridge > Start")
        end
      end

      # Auto-start
      UI.start_timer(2, false) { start_server }

      @menu_loaded = true
    end

  end
end
