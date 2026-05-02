1. for perlin noise add W offset






10. RGB seperate node



12. Add right click menu for nodes and a "Code Editor" button. hitting that opens that code of that node in a IDE code editor in the parameters window

13. Update Array node: linear, radial, spiral, concentric - with contextual parameters for each one. I am also notiving that the array node doesnt allow the indiviudual cells to overlap, they just cutoff when we for example scale stuff up



compute shaders


21. allow more zoom out and more room for the node editor. Ie move canvas in each direction. 



33. audio decomposition - split the audio into low meduium high, one input - audio, 3 audio outputs 

33.1 sprectral converter for audio. Some set of various alorithims and compositions for taking audio input and outputing a field that we can use to control


36. the solid color node should have a vec3 output with its color. We should add a hex input int he parameters section

37. add undo to the transform handles when manipulated in the canvas preivew. Holding shift while resizing any transform handle makes it keep locked ratio (this affects any node that uses those controls)

38. spline morph node with GSAP svg morph


40. allow a vec2 position to be added to a UV to offset it? or maybe add a set position node? where we move the origin/center of whatever we are setting to match to a vec2 position input?


42. advection node

43. image should be allowed to be pipped into a scalar. 


45. hide the minimap in the node editor



49. Some way to do metaballs

50. some way to do proximity join/merge for splines (accept multiple splines or a spline group as input)

51. Right click menu in load page (projects panel) that lets you rate a project. we should count the ratings in the database and then average them and show that rating with the number of ratings


53. image data should be able to drive UV data

54. Iterative render. Some sort of node that takes multiple inputs and then lets you render the full chain with each of them, 1 after another. Saves everything as a .zip file.

55. Spline draw has a tool for doing various shape primatives. 



61. index debug


66. Variable font support. proximity masking effects for each variable axis based on an image mask.


69. we need project resoloution to be saved and loaded with the project

70. a split viewport. Add the ability to split the viewport into 2. When the view port is split, every node gets an additional toggle - so "A" for active becomes, "A1" and "A2" which designates if its active in editor 1 or 2. The split should be 2 viewports stacked. 

71. Id like to add a node that basically does a proximity merge for sets of splines. like a metaball effect but more general purpose so it could work on open splines as well. Do you understand? provide a few strategies for this node

72. In the window node add "Generate Node" this should open a modal that is essentially a text input field with an explanation of whats happening. It will have a loading bar for when the api call is happening, and it would be cool to actually show the node their in the modal in place of the loading bar when its done. This interface will be a Claude api call and heres how it works. We let a user ask for a node. We include in their prompt, a claude.md instruction file for exactly how to write new nodes for our system. Idk if this feature will work well as we are saying claude must 1 shot it with only the markdown file as guidance. We will see.

So I think you should first set up the modal, the infrastructure for calling the api. Set up the entry in the Window menu dropdown. Then look at a bunch of nodes, read the docs, and then write a general purpose context markdown that can get passed along with the users prompt. Then Set up the infrastructure to basically allow nodes to be temporarily added to the interface (under a user generated section). These nodes dont need to be saved for now. This can be like an experimental feature



74. cmd + n for the new button/action

74. shortest path node

75. Index selection nodes. Logic noded (if then and or not equal not equal)


77. Lottie export?




80. Change the "points on path" to "spline to points" and add a points output socket. 

81. the trails node outputs image data. but when i use a color ramp, i feel like i should be able to control the trail color where earlier trails are a certain color and newer ones are different. but thats not how it works, walk me through some diffretn strategies. 


84. In the spline draw Id like to add various alignment tools

85. for curve primitives (circle and rectangle for now) 

86. add point and spline compatibility to the simulation zone


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

109. A view of the program that is more AE like. So we would have the tracks editor at the bottom spanning the whole page width, the timeline below it. The canvas on topright taking up most of the screen.

in this form we would mostly hide the node editor and instead we would add stuff via a quick menu (in the menu bar). The options there would be like adding a spline primitive, but when you add it, in the background it adds 


Then wed add some sort of abstraction where clicking a track group would show 

110. more polymorphic nodes: Compare, Logic, Clamp, Lerp, Smooth, Switch could all become polymorphic in the same pattern (resolveInputs checks connectedTypes, compute branches on wired type). Flag what's next.


111. how can we add a bevel and embosss filter?

112. We need to work on the transform node. 
1. Undo is broken when we manipulate the transfrom handles in the cavas, it undos in super super small steps.
2. we need to add shift left click drag to either scale proportionally when dragging scale handles. Or when we are moving it constrains movement to the direction you are dragging..
3. when holding alt/option and draging scale handles we need to make that do propotional scale (horizontially or vertically only depending on the handle or if a corner, the drag direction.)
4. Whenw the transform node is in spline mode, I want the bounds to be constrained to the minimum square that fits around the spline. 


113. Id like to have a rasterize spline node which basically combines stroke and fill so we can do it in one node. Both should be togglable. Keep the independent nodes as well. 

114. investigate what other transform.js nodes we can add


116. I want to be able to copy a group of SVG/spline elements in figma (a group or just a selection of a few) and be able to paste directly into the node editor, with each element give its own node, with them all stacked vertically, with all of them wired into a group node. it should be visually neat.

117. box select in node editor currently only selects a node if its totally inside the selection, but i woudl rather selection work if any part of a node is inside the select box

118. add a toggle called show selected only in the tracks editor that allows you to filter which tracks are shown based on what node is selected (button near the tabs)

119. When you first load up the site, we should start the user with the Load projects menu/area active (show private if we are logged in, show public if we are not logged in)

120. hide the minimap in the node editor