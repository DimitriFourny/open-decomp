#!/usr/bin/env python3
"""Benchmark-only pinned bridge lane retaining a real DecompInterface per program.

The unchanged bridge is a separate comparison lane. This adapter changes only
interface lifetime, retains upstream default decompiler options and response
shape, and records real phase boundaries outside MCP responses. No target runs.
"""
from contextlib import contextmanager
from dataclasses import replace
from functools import wraps
import json
import os
from pathlib import Path
import time

os.environ['JAVA_TOOL_OPTIONS'] = (
    os.environ.get('JAVA_TOOL_OPTIONS', '') + ' -Djava.awt.headless=true'
).strip()

from ghidra_mcp import service as service_module
from ghidra_mcp.config import load_settings
from ghidra_mcp.registry import ToolRegistry
from ghidra_mcp.tools.analysis import _function, _identity, _new_decompiler
from ghidra_mcp.tools.navigation import ToolInputError


class PersistentLane:
    def __init__(self, workspace):
        self.workspace = workspace
        self.interfaces = {}
        self.sequence = 0
        self.current = None
        self.metrics = Path(os.environ['OPEN_DECOMP_PERSISTENT_METRICS'])
        self.metrics.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def phase(self, name, **details):
        started = time.perf_counter()
        error = None
        try:
            yield
        except BaseException as failure:
            error = repr(failure)
            raise
        finally:
            record = {'sequence': self.current, 'phase': name,
                      'elapsed_ms': (time.perf_counter() - started) * 1000,
                      'error': error, **details}
            with self.metrics.open('a') as stream:
                stream.write(json.dumps(record) + '\n')

    def dispose(self, program_id):
        interface = self.interfaces.pop(program_id, None)
        if interface is not None:
            with self.phase('interface_dispose', program_id=program_id):
                interface.dispose()

    def decompile_function(self, program_id: str, address: str,
                           timeout_seconds: int = 30,
                           max_chars: int = 50_000) -> dict[str, str | bool]:
        # Same pinned tool input contract and default options; no result cache.
        if not 1 <= timeout_seconds <= 300:
            raise ToolInputError('timeout_seconds must be between 1 and 300')
        if not 1 <= max_chars <= 200_000:
            raise ToolInputError('max_chars must be between 1 and 200000')
        api = self.workspace.get(program_id)
        program = api.getCurrentProgram()
        function = _function(api, address)
        interface = self.interfaces.get(program_id)
        reused = interface is not None
        if interface is None:
            with self.phase('interface_create_open', program_id=program_id):
                interface = _new_decompiler()
                try:
                    if not interface.openProgram(program):
                        raise RuntimeError(f'Cannot open decompiler: {interface.getLastMessage()}')
                except BaseException:
                    interface.dispose()
                    raise
                self.interfaces[program_id] = interface
        try:
            with self.phase('decompile_function', program_id=program_id,
                            address=address, interface_reused=reused):
                result = interface.decompileFunction(function, timeout_seconds, None)
                if not result.decompileCompleted():
                    raise RuntimeError(f'Decompile failed: {interface.getLastMessage()}')
                decompiled = result.getDecompiledFunction()
                if decompiled is None:
                    raise RuntimeError('Decompile completed without C text')
            with self.phase('render_c', program_id=program_id, address=address):
                text = str(decompiled.getC())
                return {**_identity(function), 'c': text[:max_chars],
                        'truncated': len(text) > max_chars}
        except BaseException:
            # A failed/timed-out native request cannot authorize retained state.
            self.dispose(program_id)
            raise

    def program_close(self, program_id: str) -> dict[str, str]:
        self.dispose(program_id)
        self.workspace.close(program_id)
        return {'closed': program_id}

    def wrap(self, name, handler):
        @wraps(handler)
        def measured(*args, **kwargs):
            self.sequence += 1
            self.current = self.sequence
            try:
                # analysis_run can mutate the program; never retain old analysis.
                if name == 'analysis_run':
                    self.dispose(kwargs.get('program_id', args[0] if args else None))
                with self.phase('tool_handler', tool=name):
                    return handler(*args, **kwargs)
            finally:
                self.current = None
        return measured


_original_registry = service_module.build_default_registry
_lane = None


def persistent_registry(workspace):
    global _lane
    _lane = PersistentLane(workspace)
    original = _original_registry(workspace)
    registry = ToolRegistry()
    # No writable annotation/type/function tools can invalidate retained facts.
    enabled = {'program_open', 'program_close', 'program_info', 'symbols_list',
               'functions_list', 'analysis_run', 'decompile_function'}
    for definition in original.enabled_tools():
        if definition.name not in enabled:
            continue
        handler = definition.handler
        description = definition.description
        if definition.name == 'decompile_function':
            handler = _lane.decompile_function
            description += '\nBenchmark lane: retains DecompInterface until program_close; no text cache.'
        elif definition.name == 'program_close':
            handler = _lane.program_close
        registry.register(replace(definition, handler=_lane.wrap(definition.name, handler),
                                  description=description))
    return registry


service_module.build_default_registry = persistent_registry
service = service_module.create_service(load_settings())
original_analyze = service.workspace.runtime.analyze
original_close_all = service.workspace.close_all


def measured_analysis(program):
    with _lane.phase('auto_analysis'):
        return original_analyze(program)


def close_all():
    failures = []
    for program_id in tuple(_lane.interfaces):
        try:
            _lane.dispose(program_id)
        except BaseException as error:
            failures.append(error)
    try:
        original_close_all()
    except BaseException as error:
        failures.append(error)
    if failures:
        raise BaseExceptionGroup('Persistent lane cleanup failed', failures)


service.workspace.runtime.analyze = measured_analysis
service.workspace.close_all = close_all
# Match the unchanged bridge launcher: JVM starts on the Python main thread.
with _lane.phase('jvm_startup'):
    service.workspace.runtime.ensure_started()
service.run()
