


10. RGB seperate node

compute shaders





33. audio decomposition - split the audio into low meduium high, one input - audio, 3 audio outputs. AND a feature im not sure how to accomplish, audio decomp by hz + quantization to certain intervals. The idea is we could have pitch drive a parameter changing.
    DONE (v1) — Audio Bands node (Low/Mid/High energy as 3 scalar outputs + a
    `level` primary; crossovers, smoothing, linear/dB). Pitch via Audio Pitch node
    (McLeod NSDF detection → quantize chromatic/scale/EDO → output MIDI / normalized /
    Hz, with confidence gate, hold, and glide). Bands emit SCALARS, not audible
    filtered streams (hearable band-split deferred — needs an AudioValue filter
    extension). Shared engine/audio-analysis.ts; frame-accurate in offline export.
    Spec: 062926_audio-analysis.md.

33.1 sprectral converter for audio. Some set of various alorithims and compositions for taking audio input and outputing a scalar field that we can use to control other parameters
    DONE (v1) — Audio Spectral node: FFT → spectrum image (a spatial scalar field,
    coerces to mask) under linear / log / mel / waveform / chroma AND a 2D spectrogram
    (log-frequency × scrolling time history — accumulated live, reconstructed
    deterministically offline). Params: resolution, history rows, dB window, contrast,
    temporal smoothing, orientation, mirror. Feed it into Displace / Copy-to-Points /
    gradients / SDF fields. Frame-accurate offline. Spec: 062926_audio-analysis.md.


36. DONE the solid color node should have a vec3 output with its color. We should add a hex input int he parameters section

37. DONE add undo to the transform handles when manipulated in the canvas preivew. Holding shift while resizing any transform handle makes it keep locked ratio (this affects any node that uses those controls)

38. DONE spline morph node with GSAP svg morph


40. allow a vec2 position to be added to a UV to offset it? or maybe add a set position node? where we move the origin/center of whatever we are setting to match to a vec2 position input?


42. advection node


49. Some way to do metaballs

50. some way to do proximity join/merge for splines (accept multiple splines or a spline group as input)
    DONE — extended the Proximity Join/Merge node (type "proximity-merge").
    Adds an `op` toggle: JOIN stitches open subpath endpoints within the
    distance into continuous / closed paths (real topology change), SNAP
    keeps the original centroid clustering. Inputs auto-grow (always one
    spare empty socket; a single socket also takes a Collect'd spline
    group); animate/`t` slides parts together and commits at t=1.
    Spec: specdocs/070126_proximity-join-merge.md. (Also covers #71.)

51. Right click menu in load page (projects panel) that lets you rate a project. we should count the ratings in the database and then average them and show that rating with the number of ratings


53. image data should be able to drive UV data

54. DONE Iterative render. Some sort of node that takes multiple inputs and then lets you render the full chain with each of them, 1 after another. Saves everything as a .zip file.

55. DONE (v1) Spline draw has a tool for doing various shape primatives.
    Rectangle (R) + Ellipse (E) in the overlay's tool dock: drag a rubber-band
    box, release commits one closed subpath (corner anchors / KAPPA-handled
    quadrant anchors) that stays fully editable. Shift = 1:1 (square/circle,
    screen-space), Alt/Option = draw from the centre, Alt+Shift = both;
    snapping applies to the origin and the free corner. More primitives
    (polygon / star / rounded-rect) are the fast-follow — see #152.
    Spec: 071926_spline-draw-authoring-upgrade.md M6. 



61. index debug


66. Variable font support. proximity masking effects for each variable axis based on an image mask.


69. DONE we need project resoloution to be saved and loaded with the project

70. DONE a split viewport. Add the ability to split the viewport into 2. When the view port is split, every node gets an additional toggle - so "A" for active becomes, "A1" and "A2" which designates if its active in editor 1 or 2. The split should be 2 viewports stacked. 

71. Id like to add a node that basically does a proximity merge for sets of splines. like a metaball effect but more general purpose so it could work on open splines as well. Do you understand? provide a few strategies for this node
    DONE — see #50 / the Proximity Join/Merge node. JOIN mode works on
    open splines (endpoint stitching). Pure metaball blobbing (implicit-
    surface fusion) is still a separate idea — see #49.

72. DONE In the window node add "Generate Node" this should open a modal that is essentially a text input field with an explanation of whats happening. It will have a loading bar for when the api call is happening, and it would be cool to actually show the node their in the modal in place of the loading bar when its done. This interface will be a Claude api call and heres how it works. We let a user ask for a node. We include in their prompt, a claude.md instruction file for exactly how to write new nodes for our system. Idk if this feature will work well as we are saying claude must 1 shot it with only the markdown file as guidance. We will see.

So I think you should first set up the modal, the infrastructure for calling the api. Set up the entry in the Window menu dropdown. Then look at a bunch of nodes, read the docs, and then write a general purpose context markdown that can get passed along with the users prompt. Then Set up the infrastructure to basically allow nodes to be temporarily added to the interface (under a user generated section). These nodes dont need to be saved for now. This can be like an experimental feature




74. shortest path node
    DONE — Shortest Path node, points-first: routes through a point cloud
    (hops within a max distance) from a start position to an end position
    or end group, snapped positions wireable (Point/Cursor); visited
    points ride an aux output. A `spline` mode walks a wired network's
    own curved segments instead (groups or seeded-random endpoint pairs).
    See #173. Spec: specdocs/071026_spline-points-nodes.md.

75. Index selection nodes. Logic noded (if then and or not equal not equal)


77. Lottie export?




80. Change the "points on path" to "spline to points" and add a points output socket. 
    PARTIAL — a dedicated Spline to Points node now exists (2026-07-31):
    spline in → its raw ANCHOR positions as points (subpath order,
    groupIndex from the subpath's tag or index, spline passthrough aux).
    That's a different extraction than Points on Path's arc-length
    sampling, so the rename here is now off the table — the "Spline to
    Points" name is taken by the anchor extractor.

81. the trails node outputs image data. but when i use a color ramp, i feel like i should be able to control the trail color where earlier trails are a certain color and newer ones are different. but thats not how it works, walk me through some diffretn strategies. 


84. In the spline draw Id like to add various alignment tools

85. for curve primitives (circle and rectangle for now) 

86. add point and spline compatibility to the simulation zone
    DONE — the Simulation Start/End nodes already carried a `kind` toggle
    (image | points | spline) with per-kind state; the missing piece was
    that the two halves' `kind` didn't stay in sync. Now an edit to `kind`
    on either half mirrors to its paired half (matched by shared zone_id)
    in the same undo step, re-resolving the partner's socket types — so
    switching a zone to points/spline no longer requires flipping both
    dropdowns and can't silently thrash the shared state blob on a
    mismatch. Also stored the points state as a typed-array PointsValue
    (no per-frame Point[] round-trip through the sim hot path) and made
    the frozen EMPTY_POINTS sentinel safe to pass through ensurePointArray.


88. the timeline has issues when 

89. a spreadsheet viewer and node for using data. 

90. an api node for setting up live data sources

91. speed up dither shader?

92. Daw style nodes? Whole audio toolkit? instrument nodes, 

93. Shift select in node editor. Specific behavior for shift selecting things like primitives and transform nodes: I want to be able to select a group of transform nodes and see the overlayed controls all at once. That way I can edit positions of stuff without going back and forth to the node editor. 

94.

95. 







97. save the loop frame # for the project when we save the project.

98. box select in node editor should select any node thats underneath it at all, not just ones that are totally under it

99. fully set up the webgpu pipes

100. we need to be able to copy paste keyframes. mulptiple at a time even (like two from different trakcs, both get pasted to their respected tracks using playhead as arget locationd)

101. add dedicated logs for errors

102. show the keyframes easying on hover

103. Serversent events

104. SDF nodes. (spline)

105. export controls in tool

converting data types

106. undo doesnt work well for position changes using transform handles in the canvas it undos in very small incremental positional changes

107. array node doesnt work well becuase it squashes instances when we raise the count in either firestion


https://github.com/matsuoka-601/webgpu-ocean

108. for math node add dropdown for operation on the node itself

109. A view of the program that is more AE like. So we would have the tracks editor at the bottom spanning the whole page width - always open, the timeline below it. The canvas on topright taking up most of the screen. and then the top left panel would be one panel with two tabs for node editor and parameters (default to parameters).

in this form we would mostly hide the node editor and instead we would add stuff via a quick menu (in the menu bar). The options there would be like adding a spline primitive, but when you add it, in the background it adds 


Then wed add some sort of abstraction where clicking a track group would show 

110. more polymorphic nodes: Compare, Logic, Clamp, Lerp, Smooth, Switch could all become polymorphic in the same pattern (resolveInputs checks connectedTypes, compute branches on wired type). Flag what's next.





114. investigate what other transform.js nodes we can add


116. I want to be able to copy a group of SVG/spline elements in figma (a group or just a selection of a few) and be able to paste directly into the node editor, with each element give its own node, with them all stacked vertically, with all of them wired into a group node. it should be visually neat.




121. Right click on layers inside merge to rename the layers
122. 

123. Depth map node fast and accurate mode 

124. specific lora/image to image model for doing pencil sketch
125. kuwahava filter


looks great. ok Two architectural questions. One is I want to make export better for video, and I'm wondering if, one, we can make it more seamless by maybe using a web worker. Okay. And then the other one is... I'm curious if we can do some sort of option for simultaneously exporting ProRes and m p four. Or if that doesn't make sense. Okay. And then next, we want to figure out what loading a local file would look like? And I have a few ideas. The first and the simplest is probably some sort of manifest doc type. So, like, a JSON. Then the other idea is a custom file extension with some sort of code. Maybe it's a custom file extension, but underneath it's JSON or something. Or maybe we have some sort of custom decoder or something that reads our custom file format. And then the other idea is that what if we could encode the node network definition for the project file inside every single export? So a PNG would contain metadata that defines the node graph, and then we could just, you know, load in

render should be on a web worker and we should create a render queue

ok id like to shift to building out and refining the output/export node. 

so currently the output node's parameters let you define all the settings for video/ export. the node also lets you do the app export by hitting a button on the node.

I want to add an output socket to that node

I also want to add a new node called Render Queue

The render queue should basically have a socket input (that receives wires only from the output socket of the)


128. 

I want to change the slider style. Instead of a line with a slider dot, I want 

129. implement depth map node (depth anything web)

130. ADD rasterize spline inside all the spline generator nodes (rect, circle, etc)

131.darken bg of node editor

141. image to spline converter node

I want to add a luma key node. this node should let you draw on it to create a color selection and then it outputs a mask using that color range

RGB curves node

I want to add a node that is a curve. The main mode is a combo rgb curve, but you can toggle to edit individual r g and b curves (we can probably reuse the implementation of the graph editor). The editor should occupy the width and height of the parameters editor, resizing as the editor resizes. It should always be 0-1 on both axis. Points should not be able to be dragged further than 0 or 1. we allow double clicking curve to add new points, right click to remove


realtime segmentation node (segment anything realtime?)

when we drag in a video or image, or we upload one, Id like to change the node lable from "Image Source" or "Video Source" to the actual file name. Same thing for the label in the tracks editor

when we hit the projects options to open our projects


One thing that we do is pull in local files to work with. but the save function doesnt save videos. Ideally we could remember the path that those videos came from and try to relink them. That way if we are using the same computer they will easily relink

Another thing is that if we load a .toolbox file, we should be able to autolink the files that were kept in that folder. 

instead of a 


when you mouse over the timeline, i want a faded red playhead to follow cursor position. 


holding shift then doing box select in node editor should be able to add nodes to selection

the filled" lighter portion of the slides in the parameters panel can be a bit darker

when we click a node lets have the highlight outline fade in instead of just appear

for the keyframe diamonds in parameters panel i want a carrot on either side that lets us jump to the ext keyed frame forward or back (this will probably make the actual slider (if its a slider) less wide, thats fine)




130.

Ok big feature idea. I want to make the viewport much more interactive.

First, for all shape primitives (lets start with just spline generators (circle rectangle etc) I want to include transform handles (like a gizmo that can manipulate the parameters of the primitive - reuse stuff from the transform node where possible)

Then I want to develop a system where if we have no nodes selected, we can actually click inside the canvas area to select a node. Multiple repeated clicks in close succession dives deeper into lower layers. This probably has a ton of edge cases. we can think through some of them together first before implementing. I think it makes most sense to limit this selection process to primitive nodes that have transform handles?



131. theres a tiny but of extra space at the bottom of the main menubar. can you reduce it a tiny bit so it optically matches the top

132. copy to points should accept an image group, and then we should have a pick instance toggle and an ID input socket. Then we can feed in image data - like a noise - to randomly select which image from the group to use for each point.

133. I want to add two features. first a breadcrumb/hierchary indicator at the top left of the node editor. 

It should be a series of small rounded rectangles. The highest one is always the project name.

Then I want to add the idea of a node group. How it works is we should be able to select 1 or more nodes, hit cmd + g, and put all those nodes into their own group - a single node called "group" with inputs and outputs. The inputs and outputs are at minimum whatever the ajoining nodes connected nodes are on the right or left. So if we have 6 nodes and we select the middle 4, then the group will have an input and output socket. 

Inside the group we should auto creat a Group Input, and Group output node. Those nodes will be autoconnnected but you should be able to add or remove ouput socketws (for the input node) or input sockets (for the output node).

134. we are not storing videos on cloud, but its annoying to always re add them. when we load a video can we somehow save the file path and then next time we load a project we try to auto relink? idk how that would work

135. Debug node. This node in my mind could be placed in any datastream at any position and it would return a spreadsheet view in the parameters panel of all the data passing through it. What are the key questions for this node.

136. Lets rework the merge node to put the slider and blend mode on the same line (first blend mode, then opacity slider). Update the slider style to match the main slider UI. 

137. Our new custom drop down doesnt let me do a two finger scroll on trackpad - right now it immediately closes dropdown

138. I have seen another comparable program that uses a different notion than my tracks/graph idea. Instead it has a further abstraction on top which is layers. The idea is that every layer contains a node graph and then you can do kind of normal NLE editing but then dive into a layer and look at its node graph. 

This feels like a slight tradeoff where you loose the 'everything in one graph' mentality, but you gain the ability to sequence events much much easier. 

Ideally we would find a way to elegantly merge these. 

one idea is that there is a compositing node graph that lives at the top level. This node graph only allows a squence of one node after another - no branching just compositing - its just each node represents a layer in a stack. And the primary mode for editing these layers is via a dedicated layer editor. The idea being that the user basically never needs to interact with it if they dont want to, every edit is linked. So this is basically a different notion of how a graph works - its just a node based representation of a stacked layer compositor. The only controls each node has is blend mode, and opacity slider. 

We kind of have some of this set up with the tracks editor but I think we could make this just a dedicated keyframe editor, keeping the clip editing for now, but making the Layers editor the main place where we do NLE style editing. 

This idea necessitates an additional big feature: 1. the idea of a node group. 2. a breadcrumb/hierchary indicator at the top left of the node editor. 

the breadcrumb/hierachry should be a series of small rounded rectangles. The highest one is always the project name - which is the "layers" nodegroup

For nodegroups, at minimum each layer node is a group containing a node graph. Generally How groups work is we should be able to select a group and hit tab to dive into the group. OR select 1 or more nodes, hit cmd + g, and put all those nodes into their own group - a single node called "group" with inputs and outputs. The inputs and outputs are at minimum whatever the ajoining nodes connected nodes are on the right or left. So if we have 6 nodes and we select the middle 4, then the group will have an input and output socket. The behavior is similar to blender geometry nodes.

Inside the group we should auto create a Group Input, and Group output node. Those nodes will be autoconnnected but you should be able to add or remove ouput socketws (for the input node) or input sockets (for the output node) so we can expose an arbitrary amount of parameters.

For the layers editor, we would create a new toggle in addition to tracks and graph: Layers. The layers editor would essentially be an after effects style NLE editor where is layer corresponds to a layer node. Reordering them by dragging and dropping will reorder the nodes in the layers nodegraph. Its kinda similar to the tracks editor but more closely related to an after effects editor. 



141. when editing keyframes (in tracks or layers) if the user selects multiple keyframes accross tracks/layers and option + drags them, the keys should stagger themselves with the top keys staying static and the ones underneath being staggered out/in as you drag right/left (importantly the spacing between keys on the same track should stay the same)
 

144. Font database. I want to write a script to fetch and distill all the google fonts into a json. Then for text nodes we should make the font field searchable and when the user selects the font we dynamically load it. I think we use he google api once locally to build the json. Then the other concern is that for certain things we need the actual font file. not sure how to handle that - can we download and save to database and serve it? how costly to add hosted (on supabase) fonts as users request them?

145. 




146. on text node, lets make the actual text input exposable as a socket - we can add a new socket type "string"

147. for the group input and output (inside a layer) we should make it so those cant be deleted. Also, we should make the group output node also have the functionality of the normal output node, becuase sometimes we just want to render/export from inside a layer. 

148. refine bevel and emboss

149. Templates tab in the file menu to add a specific template node network as a starting point.

150. Hover state for bezier points in spline draw

151. Datamosh node. I am not totally sure what the right idea is here. The starting point is that I think this is a node where you need to bake - maybe not! idk we should investigate. And then the next point is that you need to have 2 input layers with time. My thought is that its a node with 2 image sockets. THen in the parameters window we have a little custom UI (we can reuse stuff from the layers panel) where we can drag the two clips around so that they overlap and then the overlap is what gets moshed. We would want lots of control over the moshing, different algorithims parameters etc. 

152. spiral primitives, cross primitive (splines)

153. a bunch of preset stackable/additive text animations. per character type on, image field for position offset, image field for opacity. 

154. abstract preset node for vizualizing bezier handles basically we want to pipe in a spline, and then get new splines out that are the handle visualization. Spec: 062926_bezier-handles-node.md (Bezier Handles node: spline in → image + spline out; path overlay + handle lines + anchor/handle dots, each independently styled incl. dashed/dotted + fill).

155. something we are constantly wanting to do is to use noise to push around points or spline points. We have a set position node that i feel like could do this, but it only accepts a vec2 right now. Could we add an 2 image field inputs for X and Y? Is that the right idea?

156. So my new idea is to have a claude API chat that lets us make group nodes. I think the idea of registering a user generated new node is too complex but we could have 1. a simple expression node that lets us type javascript with specialized 

157. need a global saturation and vibrance in the color correction node

158. Another idea - i want to be able to take a node group, pass that group as context to the AI interface, and then use a LLM call to make edits to that node group. THink through what we would need to do to set that up. I am thinking that we would add to the custom right click menu on nodes, for groups we add a "Edit with AI" button. Clicking it opens the ai chat interface and we see the node added as context. Thats the ui now we need to think about what the llm call should look like?

159. DONE Currently when you are inside a layer, you have "group input" and "group output" those are fine, but I want to rename them "Layer Input" and "Layer Output" to differentiate between being inside a group and being inside a layer.

Additionally for layer output, i basically want to add all the functionality of a normal output node, ie i want to allow the user to render stuff while inside a layer and not be forced to go up to the layers context just to render

Additionally all nodes are the same color, but I want to make the layer nodes tinted blue. So the Layer input and output, the layer node itself, those should all be tinted blue.


160. Show motion paths for animated position parameters. Lets say we keyframe a X/Y position parameter at time A and then at time B. I want to show a dashed line from the ancor point at time A that leads to the ancor point at time B. This is similar to any other motion graphics package. I want to think through together how we should implement this. The thing that sticks out to me is that for any node (a primitive node or a transform node) the XY positions are disconnected. Maybe that doesnt matter.. not sure. 
    DONE (v1) — MotionPathOverlay draws a dashed trajectory + draggable keyframe diamonds on the selected gizmo node (Transform/SVG Source + Circle/Rectangle/Text/Auto Layout/Liquid Glass). The "disconnected XY" reality is fine: we sample both tracks independently, so the path shows whatever curvature the separate easing produces; a dot drag writes BOTH axes at that tick. No spatial bezier handles (the curve isn't editable as a bezier — only the keyframe points). Spec: specdocs/062926_motion-paths.md.

161. Nodes that contain multiple subpaths (text node, spline draw, SVG source) we should be able to right click and have a option that says "decompose" and that should give us an individual spline draw node for each piece of the node. So if its a text node it should be by letter, if its spline draw its by subpath etc.

162. DONE I want to improve the landing page. Ill give you a screenshot of what we have and what i want

163. DONE I want to make it more elegant to address a motion brief that needs various exports of the same content. one idea is to make certain node streams use certain node streams. But 

the more i think about it the more I am thinking we need the notion of a "composition" and then above that "project" - both are higher level than a layer. Currently in the hierarchy a project name is the highest and it just shows the nodegraph of layers. Instead i want that layer view to be a composition view (which we will name). And I want there to be a higher level called the project view. The project view will actually be a new panel that replaces the node edior while active. It will essentially be a file browser showing the structure of the .toolbox project file. So a .toolbox is always a full project, though it will start with 1 composition, and inside that 1 layer, and inside that the default nodes. 

so .toolbox (or a online project file) is a project.
inside a project are compositions - this is the highest level view ie the root. 
inside each composition, is the layers graph.
inside each layer is a nodegraph.

Let me know if you understand. 



164. The ability to export a nodegraph as a single react component, maybe this involves LLM call idk.

165. DONE The sample along path outputs the tangent as a vec2, but im not sure the right way to use that on for example, a copy to points? like if i am copying a spline to every point on a path and i want to align the rotation to the tangent or the normal of the path.. how do i do that

166. DONE In the node editor when i drag a node away, it doesnt maintain the connection/relink the ajoining nodes - can we fix that?

167. DONE Vary the DUPLICATES when you copy text to points (size, weight, leading, font, tracking, and the string shown), driven by index / groupIndex / seeded random / a field sampled at each copy's position / keyframed time. Not a pile of new nodes — enrich the two we have. Text gets string variants + a new `text_instance` output socket carrying {base style + variant strings}. Copy to Points auto-accepts `text_instance` (new sockets appear only when connected), picks the per-copy string with its existing pick_mode, and applies per-copy typographic modulation (each channel driven by index/group/random/field), then re-rasterizes text per copy. Net new = one socket type, zero new node files. Single-string is first-class (modulate typography with no variants). The per-glyph "drive an animation with an image field" idea is separate and already exists via the animator `field` driver. Spec: specdocs/070726_text-instances.md.

167. DONE the voronoi animated toggle should animate the evoloution, rather than whatever is being animated right now. (073026_voronoi-unified.md — Animated now drives W itself along a seamless always-forward loop; slice keys wrap per loop window.)

168. DONE For the shift + click drag in the node editor currently we just do it when we click and drag from a socket, but im thinking we could just allow it from a node, hold shift before clicking a node, and we draw a straight line from the origin node to the cursor and just attempt to connect the first socket output to the relevant socket input. 

169. currently we build the along path function for text into the text node. but i want to allow that 

170. potentially add a pie menu to easily open projects, assets, save. We swap
    SPEC'D 2026-07-13 — Shift+Space radial menu, opens at cursor. Hybrid
    Blender-style select (flick-and-release OR tap-and-click), 7 items
    (Save / Open Projects / Assets / New Project / Full Canvas / Split
    Viewport / Add Node), config-driven registry. House design language
    (zinc/blue inline hex, mono, pills). Spec: specdocs/071326_pie-menu.md.

171. Relax node (for points and splines)
    DONE — Relax node (utility, mode header control): points = push-apart
    de-clumping within a radius (spatial hash, deterministic); spline =
    per-subpath Laplacian smoothing (endpoints pinned, closed wraps).
    iterations + mix on both. Spec: specdocs/071026_spline-points-nodes.md.

172. DONE I actually want to expand the color node with a + button to add multiple outputs/colors to a single node. Also i want to start developing some actual controls on the node itself so we can control them there the idea being that we could have the color square and click it to open the color picker directly over the node. 


173. points to spline, shortest path (select two spline groups or select random groups by size) Set spline type (makes a spline bezier/cubic/linear),
    DONE — all three shipped (+ #171's Relax) 2026-07-10. Points to Spline
    (chain by index order, one subpath per groupIndex, linear/smooth);
    Set Spline Type (linear strips handles / smooth catmull-rom auto
    handles + tension); Shortest Path (see #74). Spec:
    specdocs/071026_spline-points-nodes.md.

174. it seems that the spline rasterizer for the stroke thickness changes when we change canvas resoloution. Can you fix that?
    DONE (code) 2026-07-12 — px/% units toggle (% = canvas-width fraction,
    resolution-independent) on Stroke / Rasterize Spline / Spline Draw /
    the primitives' bundled rasterizer, via engine/stroke-units.ts.
    Default stays px (old saves unchanged); needs an in-browser pass.
    Spec: specdocs/071226_multi-stroke.md.

175. Id like to expand the stroke effects availible. One idea is multi stroke, repeated strokes with options for repeat inner, repeat outer, how many repeats. spacing, with a float curve interface to control spacing. 
    DONE (code) 2026-07-12 — Repeat Path node (spline→spline offset
    copies, groupIndex-tagged rings) + Stroke node Repeats group
    (spacing/thickness/opacity float curves + color ramp across rings) +
    new generic float_curve param type (engine/float-curve.ts, editor
    shared with RGB Curves). Typecheck/check/lint green; needs an
    in-browser pass. Spec: specdocs/071226_multi-stroke.md.

176. svg output nodes, take a spline export and svg at a given frame.

177. interested in a compute shader that can do the combine splines type operation (a sillouette from multiple overlapping splines) but where it is more simulation like and lets pop-y and snapping. like there is a natural adaptive flow
    SPEC DRAFTED 2026-07-12 — flow mode on Spline Merge (field-based liquid
    union: blurred coverage target + temporal relaxation + curvature flow,
    ping-pong fragment shaders, no compute shader needed; spline stays
    primary via marching-squares readback). Spec:
    specdocs/071226_spline-merge-flow.md.

178. for our MCP server, it would be interesting if there were tools specifically designed to pull the code for nodes from the github which is public. then claude could dive into the code when it needs a deeper understanding of how a node works and it can also provide information to the user on specifically how to build trees.
    DONE 2026-07-12 — three server-side read-only tools (no bridge
    round-trip): get_node_source (catalog type → def file + engine-import
    pointers), read_source (scoped to src/nodes + src/engine), search_source
    (grep over the same scope). Local checkout first; GitHub raw pinned to
    the paired app's version tag as the skew fallback. scripts/mcp-source.mjs
    + three tools in scripts/mcp-server.mjs; check:mcp covers them. Spec:
    specdocs/071226_mcp-node-source-tools.md.


179. For merge node: drag to reorder handles on each layer in parameters window. Also just a bypass toggle on each layer. 
    DONE (code) 2026-07-13 — merge_layers control extracted into
    MergeLayersControl (param-controls.tsx): per-layer grip handle
    drag-reorders the stack (rewrites the layers array → resolveInputs
    re-derives the layer:<id>/mask:<id> socket order; wires reference ids so
    they follow their layer) + eye toggle sets `enabled:false`, skipped in
    merge.ts's blend chain but keeping the socket/wire. `enabled?:boolean`
    added to MergeLayer (optional = enabled, back-compat with old saves) and
    preserved through vetMergeLayers (AI authoring shape). Typecheck/check/
    lint green; needs an in-browser pass.

180. the reroute function is kinda glitchy. Deleting should remove all wires. we should be able to connect a new wire on the left side, and have it switch the input wire for the reroute. We should be able to select the reroute itself and copy paste delete it.
    DONE 2026-07-13 — replaced the edge-metadata junction/waypoint with a
    first-class reroute NODE (rendered as a dot, dissolved at flatten time so
    eval is unchanged). Delete removes all its wires, dropping a new wire on
    its left swaps the input, and select/copy-paste all come from node
    machinery — the three asks. Created by repurposing Shift-drag-across-wires
    (source→reroute→targets, any count) or double-clicking a wire. Also fixes
    the latent bug that junctions never survived save (edge `data` isn't
    serialized) — reroute nodes persist. Spec: specdocs/071326_reroute-node.md.


181. DONE For the repeat path i am noticing that when there are sharp corners, as the path offsets it overlaps itself. I want to have a way to resolve that - im thinking a mode toggle on that node and the offset node. - and then a further toggle between sharp and smooth. Sharp just cuts the overlap and resolves to a single intersection as the transition. Smooth maybe does some sort of spline merge flow resample

182. DONE (M1–M3) turn points into text: take a points output and read each
    point's own data (position, index, rotation, scale, group) as a string,
    then display those strings AS text mapped onto the point positions — 10
    points → 10 xy labels sitting on the dots. Two nodes: **Points to Text**
    (points → text_instance, the composable primitive — pair with Copy to
    Points' new `by index` pick mode) and **Point Labels** (points → image, the
    self-contained drop-and-go node). Field dropdown + custom token template
    ({x} {y} {i} {n} {rot} {rad} {sx} {sy} {g}), normalized/pixel units,
    precision; style borrowed from a wired Text node or local font/size/color.
    Spec: specdocs/071426_point-labels.md. Remaining: eyeball in-editor + M4 docs.


183. DONE (M1+M2) Per-copy variation, right side: Copy to Points spline/point
    modes get a "Tag copies" enum — instance groups (legacy) / copy index /
    target group — so downstream per-group machinery (Stroke color +
    thickness sources, Select by Index, Modulate Splines) can vary each COPY
    instead of each instance part. Stroke gets a per-subpath thickness
    source (uniform / vary by index|random|group|position × lo..hi
    multipliers) sharing one driver resolver with the color source
    (makeSubpathDriverFn in engine/spline-color-source.ts). The composed
    recipe: Circle → CTP (tag: copy index) → Stroke (ramp by group +
    thickness vary) = every copy its own color and weight, continuous,
    seeded, no upstream re-eval. Spec:
    specdocs/071826_copy-identity-stroke-width.md.

184. DONE (M1, image+spline+points collect) Iterate node — bounded for-each
    over a subgraph, the "left side" of per-copy variation and the answer to
    "randomize a generator's params per copy" without Houdini-style
    stamping. A computing group shell (third structural variant): flatten
    drops its interior wholesale; compute nested-evaluates it K times with
    index / t / seeded random injected through the interior Iteration Input
    (wire them into exposed params — randomization stays wiring, not
    parameters); results collect into an image_group / groupIndex-tagged
    spline/points, feeding CTP's variant picks + per-group styling.
    Remaining: wrap-selection creation, in-app docs page, eyeball guardrail
    behavior under heavy interiors, per-copy typographic milestone
    interplay. Spec: specdocs/071826_iterate-node.md.

185. DONE (rev 2) Iterate is a ZONE — the loop body always renders inline
    in the parent graph inside a tinted dashed region (Blender
    repeat-zone energy). No collapsed view, no toggle, no diving in.
    Membership stays parentId (all the engine/caching correctness of the
    structural group); only visibility changed. Drag a node into the
    zone to reparent it into the loop, drag it out to leave (blocked
    with a toast if wires would cross the boundary); interactive wiring
    across scopes is rejected — data crosses through Iteration
    Input/Output as designed. Remaining: compact chrome for the shell,
    shell-drag moves the whole zone, auto-mint boundary sockets on
    crossing wires, maybe zone-style rendering for groups/layers. Spec:
    specdocs/071926_iterate-zone-view.md.

186. DONE (rev 3) Iterate zone is exactly TWO nodes: iteration count, seed,
    and a NEW random min/max range live on the Iteration Input (the
    per-iteration `random` maps into that range); the collected output
    comes straight off the Iteration Output (wire a member into its
    virtual port to mint the collect socket — image comes out as an image
    group, spline/points merged with per-iteration groupIndex). The
    separate "Iterate" shell node is gone from view — engine-side the
    Iteration Output IS the computing shell. Also: dragging the Iteration
    Output moves the whole zone, and wires drawn straight across the zone
    edge auto-mint the boundary socket and route through it (exterior→
    member mints a passthrough on Iteration Input; member→exterior mints
    the collect socket). Breaking note: zones created with the earlier
    same-day three-node build don't migrate — recreate them. Spec:
    specdocs/071926_iterate-zone-view.md (rev 3).

187. DONE Iterate loop params animate: keyframe count / seed / random
    min/max on the Iteration Input (diamonds + autokey + TrackEditor
    already worked — now the shell resolves the blocks at the scoped
    clock), or expose one and wire a signal into it from outside the zone
    (audio level → random max). House wire > keyframe > constant
    precedence, resolved shell-side; wiring a loop param from INSIDE the
    zone is rejected as circular. Animated count grows/shrinks at the
    tail without reshuffling existing iterations (random is
    index-stable); an animated range slides the whole population
    smoothly. Spec: specdocs/071926_iterate-zone-view.md.

188. DONE Iterate zone ergonomics: (a) boundary wiring is lenient now —
    any member output can wire to any exterior consumer (each mints its
    own collect socket; multi-socket collection landed, one nested pass
    per iteration evaluates every tap), same exterior source wired in
    twice reuses its passthrough, and the only rejections left are honest
    ones (grouped-type mismatch, circular member→Iteration Input).
    (b) Membership gestures: plain drags never pull a node out of the
    zone (the tint stretches around it — previously exit was
    geometrically impossible since the rect followed the node);
    Cmd/Ctrl-drag ending outside the zone takes the node out, composing
    with Cmd-drag's existing detach-with-heal so blocking wires strip in
    the same gesture. Drop-in absorb unchanged. Spec:
    specdocs/071926_iterate-zone-view.md.


199. conways game of life node

200. DONE Rigid Body Simulator (`rigid-body-simulator`): 2D rigid body
    dynamics for splines — each subpath becomes a body that falls,
    tumbles, stacks, and collides with colliders, bounds, and other
    bodies. Müller shape matching over the Rope Simulator's particle
    machinery via the new shared engine/sim-kernel.ts (rope refactored
    onto it, zero behavior change). Body↔body collision is the headline:
    particle↔edge-capsule contacts, deduped deepest-per-(particle,body),
    re-projected every iteration interleaved with the shape match so
    stacks settle solid. Rigidity slider (1 = rigid → output is the
    ORIGINAL beziers under the fitted rotation+translation; <1 = jelly →
    particle rebuild; k composes over iterations × substeps). Glue on
    contact (bond rest = contact distance, 4/particle cap, glue_map
    strength field) with PIXEL-denominated breaks (bond overstretch OR
    endpoint displacement off the fitted pose — strain never fires under
    shape matching; see spec's Breaking note) → `snaps` aux. Full rope
    pin suite (ends / pin_map / animated pins capture / follow_input;
    one pin = hinge). `bodies` aux (centroid+rotation per body) drives
    Copy-to-Points image stamping. Friction/bounce maps with live
    toggles. Verified headless (17-scenario harness: rigid drop, exact
    output, pendulum, 3-stack settle without interpenetration, glue
    hold/snap, soft squash, pin_map, follow, puppet drag); browser
    feel-pass pending. Spec: specdocs/072026_rigid-body-simulator.md.

202. DONE Node cosmetics + Frames: right-click menu grew a 7-swatch tint
    row (low-alpha wash over the node body, Tailwind-400 register) and a
    Bold toggle (thick box-shadow outline ring, no layout shift) —
    applies to the whole selection when the clicked node is selected.
    Plus Blender-style Frames: Shift+F wraps the selection in a
    `frame-zone` node (shaded rect behind its members, auto-fits as
    they move — membership via each member's `data.frameId`); drag a
    node in to join, Cmd-drag out to leave, drag the edges/label to
    move frame + contents, click the top-left label to rename. All
    additive persistence, schema stays 9. Spec:
    specdocs/073026_node-cosmetics-and-frames.md.

203. Shortest Path: TREE mode — one root point picked by an index int
    slider fans out to every reachable point as a rooted tree (paths
    split, never re-join). Shape sliders: wander (direct/SPT ↔
    minimal/MST morph, one generalized Prim/Dijkstra pass), cost
    jitter + seed, max children per point, depth limit. Emit as
    overlapping root→leaf branches (Trim Path grows the whole tree
    from the root) or unique per-edge segments; aux points in settle
    order. Update modes: locked (topology captured at frame 0 /
    topology-param / count change — connections persist, edges
    stretch as points animate) | live (rebuild per frame, optional
    parent-glide smoothing: reconfigured connections glide to their
    new junction, detaching + re-fusing in branches mode).
    Implemented 2026-07-31 — buildTreeInGraph in engine/spline-graph.ts
    (generalized Prim/Dijkstra, key = α·label(parent) + cost) + tree
    mode in nodes/effect/shortest-path.ts (the node's only stateful
    corner: ctx.state locked-topology capture + glide positions,
    in-flight-only fingerprintExtras, dispose). Typecheck/lint/
    npm run check green + standalone builder smoke test; needs an
    in-browser pass. Spec: specdocs/073126_shortest-path-tree-mode.md.

201. Vector kernel (kurbo → WASM) driving an OPTIMIZE PATH node: messy
    spline/curve data in (pencil scribbles, marching-squares traces,
    sim output, traced SVGs) → the most economical clean bezier path
    within a px tolerance, corner-preserving.
    DONE (v1) 2026-07-30 — Optimize Path node (`optimize-path`, spline
    modifier: tolerance px / adaptive|optimal / corner angle° /
    smoothing / cull specks px / debug skeleton) over
    rust/toolbox-vector-kernel (kurbo 0.13.1 pinned, 77KB wasm committed
    at public/wasm/v1 + src/wasm/pkg; `npm run build:wasm` rebuilds).
    Facade+adapter engine/vector-kernel.ts: lazy main-thread init
    (passthrough + pipeline-bump until ready, fingerprintExtras busts),
    px-space conversion, per-subpath tags preserved. Two empirical
    kernel-input discoveries (spec "Kernel input shaping"): coincident-
    endpoint runs and 2^k-aligned polyline runs both fragment the fitter
    catastrophically → closed loops split into two stitched half-arcs,
    and handle-less runs encode as G1 cubics via TS Catmull-Rom tangents
    (one-sided at corners). Result: 512-pt noisy circle → 10 anchors
    (optimal) / 53 (adaptive) / 4 (adaptive + smoothing 0.6, worst dev
    0.22px — denoise-then-fit beats optimal on raw input), corners
    exact, pure cubics reproduce at 0.000px. 2026-07-31 additions:
    Smoothing 0–1 (pre-fit Relax-style Laplacian on HANDLE-LESS anchors
    only — authored geometry pinned; open endpoints pinned, closed
    wraps), Cull specks (drop subpaths under N px arc length, before
    any fitting), Debug skeleton toggle (aux `image` minted on demand:
    source path faint grey under the optimized result's pen-tool-style
    anchors+handles + an anchor-count readout; the preview fallback's
    aux-image path shows it on node select with zero wiring — Bezier
    Handles stays the fully-styled visualizer). check:kernel covers
    smoothing/cull; in the CI chain; needs an in-browser pass.
    P0 (2026-07-31, from the kernel audit): `optimal` mode is now OUR
    shortest-path/DP subdivision optimizer (opt.rs — Levien's Zulip
    sketch, unimplemented upstream) replacing fit_to_bezpath_opt: never
    worse than adaptive by construction, retires the kurbo#268 unwrap
    trap, and beats _opt on both axes (2048-seg noisy blob 75→32 verbs
    at 14× native speed; noisy-circle optimal 10→7 anchors). Lives
    entirely in our crate on kurbo's public fit_to_cubic — no fork, no
    upstream dependency; upstreaming optional. Kernel v0.2.0 (92KB).
    2026-08-02 (v0.2.1): TWO interlocking bugs found via the arrow-
    screenshot spike report + star-corpus diagnosis. (a) kurbo's corner
    test folds past 90° (|tan|), so near-reversal spike tips read as
    smooth and got curl/overshoot while moderate notches pinned exactly
    — both modes now corner-split fold-proof (normalized dot vs cos) in
    opt.rs, and Smoothing pins raw-position corners. (b) Fixing (a)
    exposed a latent kurbo degeneracy the fold had been shielding:
    exactly-straight ranges have no quartic solution and fit_to_bezpath
    bisects EXPONENTIALLY (multi-minute hang) — fixed with chord_or_fit
    (chord-cubic short-circuit per range) + our own depth-capped
    adaptive recursion; termination now unconditional. Thin tips
    interpolate at 0.000px in both modes (spike-star regression in
    check:kernel); noisy-circle improved further (adaptive 53→34,
    optimal 7→6 anchors). Both bugs worth reporting upstream.
    Worker pool + fitSampled + offset/stroke/dash remain deferred.
    Spec: specdocs/attractor-vector-kernel-spec.md.

204. DONE Curved path modes (Connect Points + Shortest Path) — a
    `path` mode enum (straight | curved | sag | flow | network |
    bundle | attract) shaping connection segments via cubic handles,
    shared through engine/segment-shape.ts (ParamDef factory +
    handle math over an index-pair edge list). curved = circular
    arcs ↔ S-curves (curvature / s_curve / flip / path_jitter); sag =
    hanging-wire droop along a gravity angle; flow = snoise-field
    tangents; network = ONE shared tangent per point so connections
    read as curves flowing THROUGH the web; bundle = one-shot edge
    bundling (parallel neighbors merge into trunks); attract = bow
    toward/away from centroid or a custom center. Connect Points:
    header control, per-pair segments. Shortest Path: points + tree
    modes only (chains decompose into edges — interior anchors get
    both handles, network ⇒ through-point smoothing, junctions stay
    tangent-consistent; glide stubs ride synthetic table entries;
    spline mode exempt — it re-emits authored geometry). Pure
    emit-time math in iso (aspect-corrected) space; connectivity,
    raw-UV max_distance, groupIndex, aux outputs untouched;
    randomness pair-keyed (stable, no shimmer). Defaults straight →
    old saves unchanged. Node-level smoke suite passed (40 checks:
    arc circularity px-space, S-morph, sag depth, tangent
    collinearity, bundle pull, attract cap, determinism, no-NaN
    extremes); needs an in-browser pass. Spec:
    specdocs/073126_connect-points-curved-paths.md.

205. M1-M3 DONE Panel pop-out windows (multi-monitor) — detach a layout leaf into
    its own OS window so a second monitor can hold the viewport or
    timeline full-screen. Same-origin `window.open` + React portal, so
    the detached panel is the SAME React tree (same state, no sync
    protocol, no second evaluator); the engine is untouched because
    `blitToCanvas` ends in a plain `drawImage` into the target canvas,
    which works cross-document same-origin. The real work is the
    window/document coupling sweep — detachable panels must resolve
    their window from `ownerDocument.defaultView`, never module scope.
    M1 (risk gate) SHIPPED 2026-08-02: one popped-out watch viewport —
    layout/PanelPopout.tsx + removeLeaf/attachLeaf ops + the kind
    menu's Pop Out entry; verified in Electron that synthetic events
    fire in the child and the cross-document blit lands. M2+M3 SHIPPED
    2026-08-03: params, timeline and node editor all pop out. Shared
    layout/panel-window.tsx (usePanelWindow context + ownerWindow/
    ownerDocument + broadcastAppEvent) drove a ~80-site window/document
    sweep across ParamPanel, param-controls, TrackEditor, LayersEditor,
    NodeEditor and EffectNode; the app's window CustomEvents now
    broadcast to every window, and nodes-pane-scope splits into
    per-window scope (keystrokes) vs global scope (broadcasts) so a
    broadcast can't open one popup per window. Still open: M4
    persistence (per-machine localStorage, NOT in the project blob) +
    polish. Primary viewport stays undetachable; the pie menu doesn't
    reach a detached pane. Spec:
    specdocs/080226_panel-popout-windows.md.

206. SDF materials + unified shading — give the SDF compiler a color
    channel so per-shape color survives the combine operators, then one
    terminal (`SDF Shade`) that reads the field as a continuum. The
    blocker is structural: `emitSdf` collapses the tree to a single
    `float`, so by render time "which shape am I near" is gone. Fix is
    a `Surf { d, c, acc, accW }` struct emitter beside the existing
    float one — smooth-union's own `h` factor mixes color across the
    same bridge the distance blends over, so the EXISTING SDF Smooth
    Union starts mixing color with no new wire; a parallel accumulator
    gives one `bleed` knob dialing winner-takes-all → soft wash. Color
    enters three ways, one runtime-only `material` AST kind: on-node
    swatch on the 8 primitives (zero extra nodes), an `SDF Material`
    node (subtree override + wired color), and ramp × scalar_field via
    a 1×256 LUT on the sampler path (per-tile color off `posCellId` —
    impossible at any node count otherwise, since the position fold
    means one leaf covers all tiles). Colors stay UNIFORMS so
    keyframing never recompiles. `SDF Shade` = Fill / Bleed / Light
    (bevel parity + a `float_curve` height profile) / Glow / Contour,
    gated sections, plus consumption-gated aux normal/height/glow/
    bleed/mask. `sdf-rasterize` + `sdf-bevel` stay visible and gain
    material awareness; M0 gate is pixel-identical output on existing
    projects. Spec: specdocs/080226_sdf-materials-and-shading.md.

207. DONE Physarum node — GPU slime-mold transport network (Jones 2010 /
    mxsage's 36 Points parameterisation, implementation ported from
    Bleuje's interactive-physarum, CC BY-NC-SA 3.0). Millions of agents
    in RGBA32F ping-pong textures sense a decaying trail at three
    points, turn toward the strongest, step and deposit; the deposit is
    an additive gl.POINTS draw standing in for the reference's compute-
    shader atomicAdd. All 24 Points ship as presets with four
    always-visible multipliers riding on top (presets can't write back
    into sliders, so `custom` is the escape hatch), plus the reference's
    11 colour modes, a `blend` mask input driving the two-Point spatial
    interpolation per agent (strictly more general than the original's
    cursor Gaussian — wire Cursor → Circle to get the pen back), and an
    `inject` mask the agents colonise. Two normalisations are
    load-bearing and were found by rendering, not reading: a Poisson
    correction on the deposit (agent count = quality, not look) and a
    diffusion radius coupled to the distance scale (so a 4K export
    resembles its 1080p preview). Supersedes the "deferred GPU
    physarum" item in 080226_behavioral-growth.md §8; that node's CPU
    `physarum` mode is still worth building where agent positions must
    leave as a `points` value. Spec: specdocs/080226_physarum.md.
