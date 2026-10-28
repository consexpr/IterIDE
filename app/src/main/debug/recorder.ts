/** Loaded into GDB's Python interpreter; kept inline so Electron packaging needs
 * no loose Python asset and the existing compiler-relative printers still work. */
export const recorderPython = String.raw`
import gdb, json, os, time, re, hashlib, itertools, math, base64

class IterLimit(Exception):
    def __init__(self, limit):
        super().__init__('Debug resource limit: ' + limit)
        self.limit = limit

class IterReturn(gdb.FinishBreakpoint):
    def __init__(self, owner, frame, key):
        super().__init__(frame, internal=True)
        self.owner, self.key = owner, key
    def stop(self):
        self.owner.returning = True
        return True

class IterEntry(gdb.Breakpoint):
    def __init__(self, owner, location):
        super().__init__(location, internal=True)
        self.owner = owner
    def stop(self):
        self.owner.entering = True
        return True

class IterBreakpoint(gdb.Breakpoint):
    def __init__(self, owner, spec):
        super().__init__(spec['file'].replace('\\', '/') + ':' + str(spec['line']), internal=True)
        self.owner, self.spec = owner, spec
        self.remaining = max(1, (spec.get('hitCondition') or 1) - spec.get('hits', 0))
    def stop(self):
        try:
            if self.spec.get('condition') and not bool(gdb.parse_and_eval(self.spec['condition'])):
                return False
            self.owner.bp_hits[str(self.spec['id'])] += 1
            self.remaining -= 1
            return self.remaining <= 0
        except gdb.error as error:
            self.owner.condition_error = dict(id=self.spec['id'], error=str(error))
            return True

class IterTrace:
    def __init__(self, config):
        self.c = config
        self.root = os.path.normcase(os.path.abspath(config['sourceDir'])) + os.sep
        self.user_files = set(os.path.normcase(os.path.abspath(file)) for file in config['sourceFiles'])
        self.identifiers = set(config.get('identifiers', []))
        self.positions = []
        self.signal = None
        self.ended = False
        self.exit_code = None
        self.native_index = None
        self.globals = {}
        self.last = None
        self.returning = False
        self.returns = []
        self.condition_error = None
        self.bp_hits = {}
        self.bp_specs = []
        self.start_specs = []
        self.output_previous = {}
        self.node_ids = {}
        self.integer_types = {}
        self.array_samples = {}
        self.previous_array_samples = {}
        self.previous_nodes = {}
        self.previous_fingerprints = {}
        endian = gdb.execute('show endian', to_string=True)
        self.byte_order = 'little' if 'little endian' in endian else 'big' if 'big endian' in endian else None
        self.trace_bytes = 0
        self.recording_deadline = None
        self.entering = False
        self.entry_locations = None
        self.entry_breakpoints = []
        self.timings = dict(begin=0, entries=0, capture=0, encode=0, step=0)
        gdb.events.stop.connect(self.stopped)
        gdb.events.exited.connect(self.exited)

    def stopped(self, event):
        self.signal = getattr(event, 'stop_signal', None)

    def exited(self, event):
        self.ended = True
        self.exit_code = getattr(event, 'exit_code', None)

    def user(self, file):
        if not file:
            return False
        normalized = os.path.normcase(os.path.abspath(file))
        return normalized.startswith(self.root) or normalized in self.user_files

    def execute(self, command):
        self.native_index = None
        self.entering = False
        self.signal = None
        self.returning = False
        self.condition_error = None
        try:
            return gdb.execute(command, from_tty=False, to_string=True)
        except gdb.error:
            if not self.ended and not self.signal:
                raise

    def frames(self):
        result = []
        try:
            frame = gdb.newest_frame()
            while frame:
                sal = frame.find_sal()
                result.append((frame, dict(level=len(result), func=frame.name() or '??',
                    file=sal.symtab.fullname() if sal.symtab else None, line=sal.line or None)))
                frame = frame.older()
        except gdb.error:
            pass
        return result

    def choose_thread(self):
        frames = self.frames()
        if any(self.user(info['file']) for _, info in frames):
            return frames
        for thread in gdb.selected_inferior().threads():
            try:
                thread.switch()
                candidate = self.frames()
                if any(self.user(info['file']) for _, info in candidate):
                    return candidate
            except gdb.error:
                pass
        return frames

    def position(self):
        frames = self.frames()
        data = []
        for frame, info in frames:
            pc = ''
            try:
                symbol = frame.function()
                if self.user(info['file']) and symbol:
                    pc = str(frame.pc() - int(symbol.value()))
            except gdb.error:
                pass
            data.append([os.path.normcase(info['file'] or ''), info['line'], info['func'], pc])
        if frames:
            frames[0][0].select()
        return json.dumps(data, sort_keys=True)

    def step(self, command='step'):
        if command == 'step':
            self.ensure_entries()
        if self.recording_deadline and time.monotonic() >= self.recording_deadline:
            return
        before = self.frames()
        if before and self.user(before[0][1]['file']) and before[0][1]['func'] != 'main':
            try:
                frame = before[0][0]
                caller = frame.older()
                if caller:
                    caller.select()
                    key = (str(gdb.parse_and_eval('$sp')), frame.name())
                    frame.select()
                    self.returns = [bp for bp in self.returns if bp.is_valid()]
                    if not any(bp.key == key for bp in self.returns):
                        self.returns.append(IterReturn(self, frame, key))
            except gdb.error:
                pass
        origin = before[0][1] if before else None
        depth = len(before)
        skipped = False
        self.execute(command)
        for attempt in range(128):
            if os.path.exists(self.c['interruptPath']):
                if self.signal in ['SIGTRAP', 'SIGINT']:
                    self.signal = None
                return
            if self.recording_deadline and time.monotonic() >= self.recording_deadline:
                return
            if self.ended or self.signal:
                return
            frames = self.frames()
            if not frames:
                return
            frame, top = frames[0]
            if not self.user(top['file']):
                caller = next((info for _, info in frames if self.user(info['file'])), None)
                if caller:
                    gdb.execute('frame ' + str(max(0, caller['level'] - 1)), to_string=True)
                    self.execute('finish')
                    if not self.entering:
                        self.returning = True
                    skipped = True
                else:
                    self.execute('continue')
                continue
            if command == 'step' and skipped and not self.entering and origin and len(frames) == depth and top['file'] == origin['file'] and top['line'] == origin['line']:
                skipped = False
                self.execute('step')
                continue
            return
        raise gdb.GdbError('User-source stepping exceeded its library-skip bound')

    def ensure_entries(self):
        started = time.monotonic()
        if self.entry_locations is None:
            self.entry_locations = set()
            # Walk the compilation units' symbol blocks directly. Formatting
            # every function in libstdc++ with info functions costs ~1s even
            # for a tiny run. Blocks include instantiated methods and callbacks.
            main = gdb.lookup_global_symbol('main')
            if main and main.symtab:
                for block in [main.symtab.global_block(), main.symtab.static_block()]:
                    for symbol in block:
                        if symbol.is_function and symbol.name != 'main' and symbol.symtab and self.user(symbol.symtab.fullname()) and symbol.line:
                            self.entry_locations.add(symbol.symtab.fullname().replace('\\', '/') + ':' + str(symbol.line))
            # Older GDBs cannot enumerate other units' Symtab objects directly.
            # Retain the exhaustive discovery path for multi-source graders.
            others = [file for file in self.c['sourceFiles'] if not main or not main.symtab or os.path.normcase(file) != os.path.normcase(main.symtab.fullname())]
            if others:
                file = None
                for line in gdb.execute('info functions', to_string=True).splitlines():
                    if line.startswith('File ') and line.endswith(':'):
                        file = line[5:-1]
                    elif file and self.user(file):
                        location = re.match(r'\s*(\d+):', line)
                        if location and not re.search(r'\bmain\s*\(', line):
                            self.entry_locations.add(file.replace('\\', '/') + ':' + location.group(1))
            self.timings['entries'] += (time.monotonic() - started) * 1000
        if self.entry_breakpoints and all(bp.is_valid() for bp in self.entry_breakpoints):
            return
        for bp in self.entry_breakpoints:
            if bp.is_valid():
                bp.delete()
        self.entry_breakpoints = []
        for location in sorted(self.entry_locations):
            self.entry_breakpoints.append(IterEntry(self, location))

    def reset(self):
        try:
            if gdb.selected_inferior().pid:
                gdb.execute('kill', to_string=True)
        except gdb.error:
            pass
        for bp in gdb.breakpoints() or []:
            bp.delete()
        for key in ['stdoutPath', 'stderrPath', 'fileOutput']:
            file = self.c.get(key)
            if file:
                with open(file, 'wb'):
                    pass
        if self.c.get('fileInput'):
            with open(self.c['inputPath'], 'rb') as src, open(self.c['fileInput'], 'wb') as dst:
                dst.write(src.read())
        self.ended = False
        self.exit_code = None
        self.signal = None
        self.native_index = None

    def begin(self, specs=None):
        if specs is not None:
            self.start_specs = specs
        self.reset()
        self.set_breakpoints(self.start_specs)
        if not self.start_specs:
            bp = gdb.Breakpoint('main', temporary=True, internal=True)
        self.execute('run')
        # A grader main may be outside the source directory. Find the first user stop.
        if not self.ended and not self.signal:
            frames = self.frames()
            if frames and not self.user(frames[0][1]['file']):
                self.step()
        self.discover_globals()

    def discover_globals(self):
        for name in self.c.get('identifiers', []):
            for lookup in [getattr(gdb, 'lookup_global_symbol', None), getattr(gdb, 'lookup_static_symbol', None)]:
                if not lookup:
                    continue
                try:
                    symbol = lookup(name)
                    if symbol and (symbol.is_variable or symbol.is_constant) and symbol.symtab and self.user(symbol.symtab.fullname()):
                        self.globals[symbol.print_name] = symbol
                except (gdb.error, RuntimeError):
                    pass

    def integer_type(self, typ):
        key = (str(typ), typ.code, typ.sizeof)
        if key not in self.integer_types:
            self.integer_types[key] = dict(bits=typ.sizeof * 8,
                signed=typ.code != gdb.TYPE_CODE_BOOL and int(gdb.Value(-1).cast(typ)) < 0)
        return self.integer_types[key]

    def scalar(self, value, typ):
        code = typ.code
        if code in [gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR, gdb.TYPE_CODE_BOOL]:
            number = int(value)
            return dict(kind='int', value=str(number), **self.integer_type(typ))
        if code == gdb.TYPE_CODE_FLT and typ.sizeof in [4, 8]:
            number = float(value)
            if math.isfinite(number):
                return dict(kind='float', value=repr(number), bits=typ.sizeof * 8, signed=True)
        return None

    def integer_array(self, value, typ, expression, path, budget, depth, scope):
        # Never materialize the whole gdb.Value: competitive-programming arrays
        # commonly exceed GDB's max-value-size despite a tiny sampled prefix.
        low, high = typ.range()
        return self.integer_sequence(value.address, typ.target(), max(0, high - low + 1), low, expression, path, budget, depth, scope)

    def integer_vector(self, value, typ, expression, path, budget, depth, scope):
        # Use libstdc++'s actual debug fields, never invoke data()/operator[].
        # Other STL layouts and vector<bool> retain their normal printer path.
        if not re.search(r'^std::(?:__\w+::)*vector\s*<', str(typ)):
            return None
        start, finish = value['_M_impl']['_M_start'], value['_M_impl']['_M_finish']
        if start.type.strip_typedefs().code != gdb.TYPE_CODE_PTR:
            return None
        length = int(finish - start)
        if length < 0:
            return None
        return self.integer_sequence(start, start.type.strip_typedefs().target(), length, 0, expression, path, budget, depth, scope)

    def integer_sequence(self, address, element, length, low, expression, path, budget, depth, scope):
        scalar_type = element.strip_typedefs()
        if not self.byte_order or scalar_type.code != gdb.TYPE_CODE_INT or scalar_type.sizeof not in [1, 2, 4, 8, 16]:
            return None
        count = min(length, self.c['maxChildren'], budget[0]) if depth < self.c['maxDepth'] else 0
        children = []
        if count:
            layout = self.integer_type(scalar_type)
            size = scalar_type.sizeof
            data = bytes(gdb.selected_inferior().read_memory(int(address), count * size))
            key = (expression, tuple(path), scope, str(element), str(scalar_type), layout['bits'], layout['signed'], low, count)
            previous = self.previous_array_samples.get(key)
            if previous and previous[0] == data:
                children = previous[1]
                self.array_samples[key] = previous
                budget[0] -= count
                return children, length
            for i in range(count):
                offset = i * size
                # A write to one sampled element must not rebuild the other
                # immutable elements. Every stop still re-reads all sample bytes.
                if previous and previous[0][offset:offset+size] == data[offset:offset+size]:
                    children.append(previous[1][i])
                    continue
                text = str(int.from_bytes(data[offset:offset+size], self.byte_order, signed=layout['signed']))
                children.append(dict(name='[' + str(low+i) + ']', value=text, type=str(element), hasChildren=False,
                    scope=scope, selector=dict(expression=expression, path=path+[i]), scalar=dict(kind='int', value=text, **layout)))
            budget[0] -= count
            self.array_samples[key] = (data, children)
        return children, length

    def child_values(self, value):
        typ = value.type.strip_typedefs()
        printer = gdb.default_visualizer(value)
        if printer and hasattr(printer, 'children'):
            # Some libstdc++ printers (notably vector<bool>) yield Python
            # scalars rather than gdb.Value objects.
            values = ((name, child if hasattr(child, 'type') else gdb.Value(child)) for name, child in printer.children())
            return values, (printer.display_hint() if hasattr(printer, 'display_hint') else None)
        if typ.code == gdb.TYPE_CODE_ARRAY:
            low, high = typ.range()
            return (('[' + str(i) + ']', value[i]) for i in range(low, high + 1)), 'array'
        if typ.code in [gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION]:
            def fields():
                for field in typ.fields():
                    if field.name:
                        yield field.name, value.cast(field.type) if field.is_base_class else value[field]
            return fields(), None
        return iter([]), None

    def node(self, value, name, expression, path, budget, depth=0, scope='local'):
        node = dict(name=name, value='<unavailable>', type=str(value.type), hasChildren=False,
                    scope=scope, selector=dict(expression=expression, path=path))
        try:
            if value.is_optimized_out:
                raise gdb.GdbError('optimized out')
            if budget[0] <= 0:
                node.update(truncated=True, unavailable=True)
                return node
            budget[0] -= 1
            typ = value.type.strip_typedefs()
            if typ.code in [gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF]:
                value = value.referenced_value()
                typ = value.type.strip_typedefs()
            scalar = self.scalar(value, typ)
            if scalar:
                node['scalar'] = scalar
                if typ.code == gdb.TYPE_CODE_BOOL:
                    node['value'] = 'true' if int(value) else 'false'
                elif typ.code == gdb.TYPE_CODE_CHAR:
                    node['value'] = str(value)
                else:
                    node['value'] = scalar['value']
                return node
            if typ.code in [gdb.TYPE_CODE_PTR, gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF]:
                raw = str(value)
                node['value'] = raw[:16384]
                node['truncated'] = len(raw) > 16384
                return node
            printer = gdb.default_visualizer(value)
            hint = printer.display_hint() if printer and hasattr(printer, 'display_hint') else None
            if hint == 'string':
                raw = str(value)
                node['value'] = raw[:199]
                node['truncated'] = '...' in raw or bool(node.get('truncated'))
                if len(raw) > 199:
                    node.update(value=raw[:196] + '...', truncated=True)
                return node
            if (typ.code == gdb.TYPE_CODE_ARRAY and not printer) or (printer and hint == 'array'):
                try:
                    sampled = self.integer_array(value, typ, expression, path, budget, depth, scope) if typ.code == gdb.TYPE_CODE_ARRAY and not printer else self.integer_vector(value, typ, expression, path, budget, depth, scope)
                except (gdb.error, RuntimeError, TypeError, ValueError, OverflowError):
                    sampled = None
                if sampled is not None:
                    children, length = sampled
                    preview = [child['value'] for child in children[:10]]
                    truncated = length > len(children)
                    if truncated or len(children) > 10:
                        preview.append('...')
                    prefix = '[' + str(length) + '] ' if typ.code == gdb.TYPE_CODE_ARRAY else 'size=' + str(length) + ' '
                    node.update(children=children, hasChildren=length > 0, indexable=True, truncated=truncated,
                        value=(prefix + '{' + ', '.join(preview) + '}')[:199])
                    return node
            # Aggregate previews are built from the same bounded children as the
            # tree. str(value) first would eagerly format a giant struct/array,
            # often failing before a single requested child can be inspected.
            raw = ''
            if printer and hasattr(printer, 'to_string'):
                summary = printer.to_string()
                raw = summary if isinstance(summary, str) else ''
            if not printer and typ.code not in [gdb.TYPE_CODE_ARRAY, gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION]:
                raw = str(value)
            node['value'] = raw[:16384] if raw else '{...}'
            if len(raw) > 16384:
                node['truncated'] = True
            values, hint = self.child_values(value)
            count = self.c['maxChildren']
            pairs = list(itertools.islice(values, count + 1))
            node['hasChildren'] = len(pairs) > 0
            node['indexable'] = typ.code == gdb.TYPE_CODE_ARRAY or bool(printer and hint == 'array' and re.search(r'^std::(?:__\w+::)*(?:vector|array|deque)\s*<', str(typ)))
            if depth >= self.c['maxDepth'] or budget[0] <= 0:
                node['truncated'] = bool(pairs)
                return node
            children = []
            for i, (label, child) in enumerate(pairs[:count]):
                if budget[0] <= 0:
                    break
                children.append(self.node(child, str(label), expression, path + [i], budget, depth + 1, scope))
            node['children'] = children
            node['truncated'] = bool(node.get('truncated')) or len(pairs) > len(children)
            preview = []
            if hint == 'map':
                for i in range(0, min(len(children), 20), 2):
                    preview.append(children[i]['value'] + ' -> ' + (children[i+1]['value'] if i+1 < len(children) else '<truncated>'))
            else:
                for child in children[:10]:
                    preview.append(child['value'] if hint == 'array' or typ.code == gdb.TYPE_CODE_ARRAY else child['name'] + '=' + child['value'])
            if node['truncated'] or len(children) > (20 if hint == 'map' else 10):
                preview.append('...')
            if pairs:
                prefix = ''
                if typ.code == gdb.TYPE_CODE_ARRAY:
                    low, high = typ.range()
                    prefix = '[' + str(high-low+1) + '] '
                elif hint in ['array', 'map']:
                    size = re.search(r'(?:length|with)\s+(\d+)', raw)
                    prefix = 'size=' + size.group(1) + ' ' if size else ('size>=' if node['truncated'] else 'size=') + str(len(children) // (2 if hint == 'map' else 1)) + ' '
                node['value'] = (prefix + '{' + ', '.join(preview) + '}')[:199]
            return node
        except (gdb.error, RuntimeError, ValueError, OverflowError) as error:
            node.update(value='<unavailable: ' + str(error)[:160] + '>', unavailable=True)
            return node

    def bindings(self, frame, info, budget):
        if not self.user(info['file']):
            return []
        frame.select()
        result, names = [], set()
        try:
            block = frame.block()
            while block and not block.is_global and not block.is_static:
                for symbol in block:
                    name = symbol.print_name
                    if name not in self.identifiers and name != 'this':
                        continue
                    if name in names or not (symbol.is_variable or symbol.is_argument):
                        continue
                    names.add(name)
                    try:
                        node = self.node(frame.read_var(symbol), name, name, [], budget)
                        node['future'] = bool(not symbol.is_argument and symbol.line and info['line'] and symbol.line >= info['line'])
                        result.append(node)
                    except (gdb.error, RuntimeError):
                        result.append(dict(name=name, value='<unavailable>', hasChildren=False, unavailable=True, scope='local'))
                block = block.superblock
        except (gdb.error, RuntimeError):
            pass
        return result

    def offsets(self):
        def size(key):
            try:
                return os.path.getsize(self.c[key]) if self.c.get(key) else 0
            except OSError:
                return 0
        return dict(stdoutOffset=size('stdoutPath'), stderrOffset=size('stderrPath'), fileOutputOffset=size('fileOutput'))

    def output_changes(self):
        changes = {}
        total = sum(self.offsets().values())
        if total > self.c['outputLimitBytes']:
            raise IterLimit('output')
        for stream, key in [('stdout', 'stdoutPath'), ('stderr', 'stderrPath'), ('file', 'fileOutput')]:
            try:
                with open(self.c[key], 'rb') as src:
                    parts, length = [], 0
                    while True:
                        part = src.read(min(65536, self.c['outputLimitBytes'] + 1 - length))
                        if not part:
                            break
                        length += len(part)
                        if length > self.c['outputLimitBytes']:
                            raise IterLimit('output')
                        parts.append(part)
                    data = b''.join(parts)
            except (OSError, KeyError, TypeError):
                data = b''
            previous = self.output_previous.get(stream, b'')
            if data != previous:
                reset = not data.startswith(previous)
                changes[stream] = dict(reset=reset, data=base64.b64encode(data if reset else data[len(previous):]).decode('ascii'))
            self.output_previous[stream] = data
        return changes

    def fingerprint(self, snapshot):
        # Exact child digests can be reused only for the same immutable node
        # object. This keeps stable aggregate prefixes out of repeated JSON work.
        current = {}
        def node_value(node):
            if node.get('future') or node.get('unavailable'):
                return None
            cached = self.previous_fingerprints.get(id(node))
            if cached and cached[0] is node:
                current[id(node)] = cached
                return cached[1]
            data = [node['name'], node.get('type'), node.get('scalar'), node.get('value') if not node.get('children') and not node.get('scalar') else None,
                    [node_value(child) for child in node.get('children', [])]]
            digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode('utf8')).hexdigest()
            current[id(node)] = (node, digest)
            return digest
        data = [[node_value(node) for node in frame['locals']] for frame in snapshot['frames']]
        data.append([node_value(node) for node in snapshot['globals']])
        self.previous_fingerprints = current
        return hashlib.sha256(json.dumps(data, sort_keys=True).encode('utf8')).hexdigest()

    def capture(self, index, reason='step'):
        # Keep only the preceding sample set. Every stop still re-reads the
        # bounded bytes; equality reuses immutable child nodes, never stale data.
        self.previous_array_samples, self.array_samples = self.array_samples, {}
        budget = [self.c['maxNodes']]
        frames = []
        native = self.choose_thread() if not self.ended else []
        for frame, info in native:
            info['locals'] = self.bindings(frame, info, budget)
            frames.append(info)
        globals = []
        for name, symbol in sorted(self.globals.items()):
            try:
                globals.append(self.node(symbol.value(), '::' + name, '::' + name, [], budget, scope='global'))
            except (gdb.error, RuntimeError):
                globals.append(dict(name='::'+name, value='<unavailable>', hasChildren=False, unavailable=True, scope='global'))
        current = next((info for info in frames if self.user(info['file'])), frames[0] if frames else {})
        if native:
            native[current.get('level', 0)][0].select()
        snapshot = dict(index=index, frames=frames, globals=globals, file=current.get('file'), line=current.get('line'),
                        returnSite=self.returning,
                        userEntry=self.entering,
                        breakpointError=self.condition_error,
                        breakpointHits={str(spec['id']): dict(hits=self.bp_hits[str(spec['id'])], condition=spec.get('condition'), file=spec['file'], line=spec['line']) for spec in self.bp_specs},
                        reason='exited' if self.ended else 'signal' if self.signal else reason,
                        signal=self.signal, exitCode=self.exit_code, signature=self.position() if native else '[]', **self.offsets())
        snapshot['fingerprint'] = self.fingerprint(snapshot)
        self.native_index = index
        self.last = snapshot
        return snapshot

    def stop_limit(self):
        try:
            if gdb.selected_inferior().pid:
                gdb.execute('kill', to_string=True)
        except gdb.error:
            pass
        self.ended, self.signal, self.exit_code = True, None, None

    def encoded(self, snapshot):
        encoded = json.dumps(self.encode(snapshot))
        size = len(encoded.encode('utf8')) + 1
        if self.trace_bytes + size > self.c['maxTraceBytes']:
            raise IterLimit('trace')
        self.trace_bytes += size
        return encoded

    def save_snapshot(self, out, reason):
        snapshot = self.capture(len(self.positions), reason)
        snapshot['outputChanges'] = self.output_changes()
        encoded = self.encoded(snapshot)
        self.positions.append(dict(signature=snapshot['signature'], fingerprint=snapshot['fingerprint'], file=snapshot.get('file'), line=snapshot.get('line')))
        out.write(encoded + '\n')
        out.flush()

    def record(self):
        start = time.monotonic()
        self.recording_deadline = start + self.c['maxDurationMs'] / 1000
        self.positions = []
        self.output_previous = {}
        limited = None
        try:
            with open(self.c['tracePath'], 'w', encoding='utf8') as out:
                while True:
                    phase = time.monotonic()
                    self.save_snapshot(out, 'entry' if not self.positions else 'step')
                    # Preserve pre-recording conditional/hit counts in snapshot zero,
                    # then let replay account for all subsequent source-step visits.
                    if len(self.positions) == 1:
                        self.set_breakpoints([])
                    self.timings['capture'] += (time.monotonic() - phase) * 1000
                    if len(self.positions) % 100 == 0:
                        gdb.write('ITER_PROGRESS:' + str(len(self.positions)) + '\n')
                    if self.ended or self.signal or limited:
                        break
                    if len(self.positions) >= self.c['maxSteps']:
                        limited = 'steps'
                        break
                    if (time.monotonic() - start) * 1000 >= self.c['maxDurationMs']:
                        limited = 'time'
                        break
                    try:
                        phase = time.monotonic()
                        self.step()
                        self.timings['step'] += (time.monotonic() - phase) * 1000
                    except KeyboardInterrupt:
                        self.signal = None
                        limited = 'time'
                        self.save_snapshot(out, 'pause')
                        break
                    if self.signal in [None, 'SIGTRAP', 'SIGINT'] and (time.monotonic()-start)*1000 >= self.c['maxDurationMs']:
                        self.signal = None
                        limited = 'time'
                        self.save_snapshot(out, 'pause')
                        break
        except IterLimit as error:
            limited = error.limit
            self.stop_limit()
        finally:
            self.recording_deadline = None
        with open(self.c['metaPath'], 'w', encoding='utf8') as out:
            json.dump(dict(ended=self.ended or bool(self.signal), limited=limited, elapsedMs=(time.monotonic()-start)*1000, timings=self.timings), out)

    def encode(self, snapshot):
        # Exact structural sharing, including unchanged aggregate elements.
        # Dictionary keys contain the full serialized descriptor, not a hash.
        definitions = []
        current_nodes = {}
        def intern(node):
            cached = self.previous_nodes.get(id(node))
            if cached and cached[0] is node:
                current_nodes[id(node)] = cached
                return cached[1]
            descriptor = dict(node)
            if 'children' in descriptor:
                descriptor['children'] = [intern(child) for child in descriptor['children']]
            key = json.dumps(descriptor, sort_keys=True)
            if key not in self.node_ids:
                if len(self.node_ids) >= self.c['maxTotalNodes']:
                    raise IterLimit('nodes')
                identifier = len(self.node_ids)
                self.node_ids[key] = identifier
                definitions.append(dict(id=identifier, node=descriptor))
            identifier = self.node_ids[key]
            current_nodes[id(node)] = (node, identifier)
            return identifier
        result = dict(snapshot)
        result['frames'] = [dict(frame, locals=[intern(node) for node in frame['locals']]) for frame in snapshot['frames']]
        result['globals'] = [intern(node) for node in snapshot['globals']]
        result['definitions'] = definitions
        self.previous_nodes = current_nodes
        return result

    def check(self, index):
        self.native_index = None
        if self.position() != self.positions[index]['signature']:
            return False
        snapshot = self.capture(index)
        matches = snapshot['fingerprint'] == self.positions[index]['fingerprint']
        if not matches:
            self.native_index = None
        return matches

    def seek(self, index):
        if self.native_index == index and not self.ended:
            return
        target = self.positions[index]
        if not target.get('file') or not target.get('line'):
            raise gdb.GdbError('No inspectable frame at the terminal snapshot')
        self.reset()
        location = target['file'].replace('\\', '/') + ':' + str(target['line'])
        bp = gdb.Breakpoint(location, internal=True)
        bp.ignore_count = sum(1 for pos in self.positions[:index] if pos['file'] == target['file'] and pos['line'] == target['line'])
        try:
            self.execute('run')
            self.discover_globals()
            if not self.ended and self.check(index):
                self.native_index = index
                return
        finally:
            if bp.is_valid():
                bp.delete()
        # Line breakpoints can have a different visit count/PC from source steps.
        # Never accept a near miss: replay the exact source-step sequence instead.
        self.begin()
        for i in range(index + 1):
            if self.position() != self.positions[i]['signature']:
                raise gdb.GdbError('Exact seek diverged: frame stack/PC differs from recording')
            if i == index:
                if not self.check(index):
                    raise gdb.GdbError('Exact seek diverged: recorded values differ')
                self.native_index = index
                return
            if self.ended or self.signal:
                raise gdb.GdbError('Exact seek ended before its target')
            following = self.positions[i+1]
            movement = following.get('movement', 'step')
            self.set_breakpoints(following.get('breakpoints', []) if movement == 'continue' else [])
            if movement == 'continue':
                self.execute('continue')
            else:
                self.step(movement)

    def query(self, request):
        self.native_index = None
        self.set_breakpoints([])
        level = request.get('frame', 0)
        gdb.execute('frame ' + str(level), to_string=True)
        value = gdb.parse_and_eval(request['expression'])
        for index in request.get('path', []):
            values, hint = self.child_values(value)
            item = next(itertools.islice(values, index, index+1), None)
            if item is None:
                raise gdb.GdbError('Requested child no longer exists')
            value = item[1]
        node = self.node(value, request['expression'], request['expression'], request.get('path', []), [self.c['maxNodes']])
        with open(self.c['queryPath'], 'w', encoding='utf8') as out:
            json.dump(node, out)
        # A user expression can call a function or otherwise mutate the seeker.
        # Rebuild the recorded state for the next uncached query, conservatively.
        self.native_index = None

    def set_breakpoints(self, specs):
        self.bp_specs = specs
        self.bp_hits = {str(spec['id']): spec.get('hits', 0) for spec in specs}
        for bp in gdb.breakpoints() or []:
            bp.delete()
        for spec in specs:
            if spec.get('enabled') and spec.get('verified'):
                IterBreakpoint(self, spec)

    def advance(self, command, index, specs):
        self.set_breakpoints(specs if command == 'continue' else [])
        try:
            if command == 'continue':
                self.execute(command)
            else:
                self.step(command)
        except KeyboardInterrupt:
            self.signal = None
        try:
            snapshot = self.capture(index)
            snapshot['movement'] = command
            snapshot['breakpoints'] = specs
            snapshot['outputChanges'] = self.output_changes()
            encoded = self.encoded(snapshot)
        except IterLimit:
            self.stop_limit()
            raise
        if index == len(self.positions):
            self.positions.append(dict(signature=snapshot['signature'], fingerprint=snapshot['fingerprint'], file=snapshot.get('file'), line=snapshot.get('line'), movement=command, breakpoints=specs))
        with open(self.c['queryPath'], 'w', encoding='utf8') as out:
            out.write(encoded)

def iter_init(config):
    global iter_trace
    iter_trace = IterTrace(json.loads(config))
`
