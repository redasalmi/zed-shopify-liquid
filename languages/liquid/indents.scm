; Paired Liquid statements. Capturing the closing keyword as @end makes the
; closing tag outdent while the statement body remains indented and foldable.
(if_statement "if" @start "endif" @end) @indent
(unless_statement "unless" @start "endunless" @end) @indent
(case_statement "case" @start "endcase" @end) @indent
(for_loop_statement "for" @start "endfor" @end) @indent
(capture_statement "capture" @start "endcapture" @end) @indent
(form_statement "form" @start "endform" @end) @indent
(paginate_statement "paginate" @start "endpaginate" @end) @indent
(tablerow_statement "tablerow" @start "endtablerow" @end) @indent

; Branches align with their parent and indent their own bodies.
(elsif_clause "elsif" @start) @indent
(else_clause "else" @start) @indent
(when_clause "when" @start) @indent

; Embedded-language and content blocks. Their injected grammars add indentation
; within the content; these captures add the surrounding Liquid level.
(schema_statement "schema" @start "endschema" @end) @indent
(javascript_statement "javascript" @start "endjavascript" @end) @indent
(style_statement "style" @start "endstyle" @end) @indent
(stylesheet_statement "stylesheet" @start "endstylesheet" @end) @indent
(raw_statement "raw" @start "endraw" @end) @indent
(doc "doc" @start "enddoc" @end) @indent

; Statements in a multiline `{% liquid %}` tag are one level deeper than the
; opening line.
(liquid_tag "liquid" @start) @indent

; Paired comments conceal their delimiters in this grammar, so the complete
; node is the most reliable indentation and folding boundary.
(comment) @indent
