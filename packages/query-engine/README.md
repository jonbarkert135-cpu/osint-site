# @nexus/query-engine

Unified query intake and planning (`RAVEN-SPEC/24_UNIFIED_QUERY.md`, roadmap P17).

One raw string from the analyst becomes ranked entity candidates (`typeQuery`) and, through the
transform layer's router and planner, a plan of what _would_ run (`planQuery`). Nothing here
executes: the layer proposes, the analyst commits.
