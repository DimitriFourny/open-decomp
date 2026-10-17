#!/usr/bin/env python3
"""Start the pinned unchanged bridge with JVM initialization on the main thread.

This avoids the observed macOS AppKit startup deadlock. All binary operations
remain upstream MCP calls; this bootstrap does not open or analyze any input.
"""
import os

os.environ['JAVA_TOOL_OPTIONS'] = (
    os.environ.get('JAVA_TOOL_OPTIONS', '') + ' -Djava.awt.headless=true'
).strip()
from ghidra_mcp.config import load_settings
from ghidra_mcp.service import create_service

service = create_service(load_settings())
service.workspace.runtime.ensure_started()
service.run()
