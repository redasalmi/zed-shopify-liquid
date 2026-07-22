; Theme composition and navigation landmarks.
(render_statement
  "render" @context
  file: (string) @name) @item

; Dynamic block regions are named by their `blocks` mode.
(content_for_statement
  "content_for" @context
  type: (string) @name
  (#match? @name "^[\"']blocks[\"']$")) @item

; Static block entries use the block `type` argument as their useful name.
(content_for_statement
  "content_for" @context
  type: (string) @context
  arguments: (content_for_argument_list
    (content_for_argument
      key: (identifier) @_type_key
      value: (string) @name)
    (#eq? @_type_key "type"))) @item

(include_statement
  ["include" "include_relative"] @context
  (string) @name) @item

(section_statement
  "section" @context
  (string) @name) @item

(sections_statement
  "sections" @context
  (string) @name) @item

(layout_statement
  "layout" @context
  [(string) "none"] @name) @item

; Control-flow landmarks include their condition or receiver.
(if_statement
  "if" @context
  condition: (_) @name) @item

(unless_statement
  "unless" @context
  condition: (_) @name) @item

(case_statement
  "case" @context
  receiver: (_) @name) @item

; Named values introduced by Liquid blocks and assignments.
(assignment_statement
  "assign" @context
  variable_name: (identifier) @name) @item

(capture_statement
  "capture" @context
  variable: (identifier) @name) @item

(for_loop_statement
  "for" @context
  item: (identifier) @name) @item

(tablerow_statement
  "tablerow" @context
  item: (identifier) @name) @item

(form_statement
  "form" @context
  type: [(string) (identifier) (access)] @name) @item

(paginate_statement
  "paginate" @context
  item: [(identifier) (access)] @name) @item

; Embedded blocks are useful file landmarks even when they have no user name.
(schema_statement "schema" @name) @item
(javascript_statement "javascript" @name) @item
(style_statement "style" @name) @item
(stylesheet_statement "stylesheet" @name) @item
(doc "doc" @name) @item
