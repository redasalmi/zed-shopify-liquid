; Zed ignores `#set! priority`; when captures overlap, the later pattern wins.
; Keep generic captures first and more specific captures after them.

(identifier) @variable

(string) @string

(boolean) @boolean

(number) @number

([
  "as"
  "assign"
  "capture"
  "content_for"
  "custom_keyword"
  "decrement"
  "doc"
  "echo"
  "endcapture"
  "enddoc"
  "endform"
  "endjavascript"
  "endraw"
  "endschema"
  "endstyle"
  "endstylesheet"
  "form"
  "increment"
  "javascript"
  "layout"
  "liquid"
  "raw"
  "schema"
  "style"
  "stylesheet"
  "with"
] @keyword)

([
  "case"
  "else"
  "elsif"
  "endcase"
  "endif"
  "endunless"
  "if"
  "unless"
  "when"
] @keyword.conditional)

([
  (break_statement)
  (continue_statement)
  "by"
  "cycle"
  "endfor"
  "endpaginate"
  "endtablerow"
  "for"
  "paginate"
  "tablerow"
] @keyword.repeat)

([
  "and"
  "contains"
  "in"
  "or"
] @keyword.operator)

([
  "{{"
  "}}"
  "{{-"
  "-}}"
  "{%"
  "%}"
  "{%-"
  "-%}"
] @punctuation.special)

[
  "include"
  "include_relative"
  "render"
  "section"
  "sections"
] @keyword.import

[
  "|"
  ":"
  "="
  "+"
  "-"
  "*"
  "/"
  "%"
  "^"
  "=="
  "<"
  "<="
  "!="
  ">="
  ">"
] @operator

[
  "]"
  "["
  ")"
  "("
] @punctuation.bracket

[
  ","
  "."
] @punctuation.delimiter

(filter
  name: (identifier) @function.call)

(raw_statement
  (raw_content) @spell)

(argument
  key: (identifier) @variable.parameter)

(content_for_argument
  key: (_) @variable.parameter)

(assignment_statement
  variable_name: (identifier) @variable)

(capture_statement
  variable: (identifier) @variable)

(for_loop_statement
  item: (identifier) @variable.parameter)

(tablerow_statement
  item: (identifier) @variable.parameter)

(access
  property: (_) @property)

((identifier) @constant.builtin
  (#any-of? @constant.builtin "blank" "empty" "nil" "null"))

; Color complete comment and doc tags, including delimiters, as comments.
(comment) @comment

(comment
  [
    "{%"
    "%}"
    "{%-"
    "-%}"
  ] @comment)

(doc) @comment

(doc
  [
    "{%"
    "%}"
    "{%-"
    "-%}"
    "doc"
    "enddoc"
  ] @comment)

(doc_content) @comment

(doc_description_annotation) @keyword

"@param" @keyword

"@example" @keyword

"@prompt" @keyword

(doc_param_name) @variable

(doc_type) @type

(doc_prompt_content) @string

; Example content is Liquid, not comment text.
(doc_example_content) @embedded
