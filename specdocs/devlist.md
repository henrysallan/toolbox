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


60. big feature, Convert To App. This feature lets you essentially export your node tree as a single app. Instead of each node being a seperate canvas/operation passing data, we concatenate the functions into a single script. We take all the controls and put them in a single panel each one listed in. I Have a few ideas for this. the first is basically we have an a button on the output node called Export App. in the background we already have a project template set up and we procedurally copy the code of the active nodes into that project file - ideally this would be a single script file or something (or it could be many idk maybe that is nicer). And then when you hit export it downloads a zip that has the boilerplate code, and our node network. Then for controls we dont want every single node control, so we add a new toggle that goes next to the "expose" toggle on a per node basis. 

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