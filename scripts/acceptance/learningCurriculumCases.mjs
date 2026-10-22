// Original synthetic utterances, authored for the approved 12 scenes × 3 levels
// × 4 behaviors. Expected outcomes are fixed before calling the teaching model.
// These are an internal benchmark, not an independent language review.
const rows=[
 ['introduce','beginner','My name is Alex. Nice to meet you.','My name are Alex.'],
 ['introduce','intermediate','I enjoy hiking and cooking. What do you like doing outside work?','I enjoys hiking. What do you like doing outside work?'],
 ['introduce','advanced',"Since you work with small businesses, you might be interested in my work as a designer. I believe simple websites serve small teams best because they are easier to maintain. What challenges do your clients face?","Since you work with small businesses, I would like to introduce my work. I has designed websites for small teams for five years."],
 ['coffee','beginner','A small coffee, please.','Two cup of coffee, please.'],
 ['coffee','intermediate',"I'd like a medium latte with oat milk. If oat milk is sold out, regular milk is fine.","I'd like a medium latte. If oat milk are sold out, regular milk is fine."],
 ['coffee','advanced','I ordered decaf, but this tastes like regular coffee. Could you check my order and replace it with decaf? I can wait a few minutes.','I ordered decaf yesterday, but you give me regular coffee yesterday. Could you replace it?'],
 ['restaurant','beginner','Noodles, please. Thank you.','I would likes noodles, please.'],
 ['restaurant','intermediate',"I'd like vegetarian noodles without peanuts. Are the vegetables fried or steamed?",'I am a vegetarian. Does these noodles contain meat?'],
 ['restaurant','advanced',"One guest is vegetarian and another cannot eat dairy. Could we order vegetable dishes and serve cheese separately? That would let everyone share the meal.","Two guests is vegetarian and another cannot eat dairy. Could we serve the cheese separately?"],
 ['shopping','beginner','I would like blue, please. How much is it?','How much are this blue shirt?'],
 ['shopping','intermediate','The cotton shirt feels softer than the other one. Do you have it in a larger size?','This shirt is more cheaper than that one. Do you have a larger size?'],
 ['shopping','advanced','The jacket has a broken zip. I bought it yesterday and have the receipt. Could you replace it? If the same size is unavailable, a refund would work for me.','The jacket has a broken zip. I buy it yesterday. Could I exchange it?'],
 ['directions','beginner','Excuse me, where is the station?','Where the station is?'],
 ['directions','intermediate','Let me check that I understood: I go straight and turn left at the bank. Is that the way to the station?','Let me check: I goes straight and then turn left at the bank. Is that right?'],
 ['directions','advanced','My train leaves in thirty minutes. A taxi is quicker but more expensive than the bus. I would take the taxi if it saves at least ten minutes. Which route would you recommend?','My train leave in thirty minutes. Would a taxi be faster than the bus?'],
 ['hotel','beginner',"I have a reservation under Alex Chen. I'd like to check in, please.",'I has a reservation under Alex Chen.'],
 ['hotel','intermediate','Could I have a quiet room away from the lift? Is breakfast included, and what time does it start?','Could I have a quiet room? What time breakfast starts?'],
 ['hotel','advanced','My confirmation is for a twin room, but your system shows a double. We need separate beds. A double with an extra bed would work if there is no additional charge. Could you arrange that?','My confirmation shows two bed, but this room has only one. Could you arrange an extra bed?'],
 ['tickets','beginner','One ticket to London, please.','I would like buy one ticket to London.'],
 ['tickets','intermediate','What time does the next train to London leave, how much is a single ticket, and will I need to change trains?','How much does a ticket costs, and do I need to change trains?'],
 ['tickets','advanced','I need to arrive before noon, but my departure date might change. The flexible ticket costs more than the fixed one. I would choose it if it lets me change the date without another fee. Does it?','I need to arrive before noon. The flexible ticket is expensive than the fixed one. Can I change the date?'],
 ['booking','beginner','Can I change my booking to Friday, please?','Can I changes my booking to Friday?'],
 ['booking','intermediate',"My meeting has moved, so could we change the booking to Friday at two? Please confirm that the new time is Friday at two in the afternoon.","My meeting has moved. Could we change the booking to Friday? I am available in Friday afternoon."],
 ['booking','advanced',"The change fee is more than I expected. Could you waive it if I move to an off-peak slot? To confirm my proposal: Friday at two, with the original price and no change fee. Would that work?","Could you waive the change fee? If you agrees, I can accept Friday at two."],
 ['appointment','beginner',"I'd like to make an appointment for Friday at two, please.","I'd like to makes an appointment for Friday at two."],
 ['appointment','intermediate',"I'd like a thirty-minute haircut on Saturday morning. Does that include a wash, and should I bring anything?",'Does the haircut includes a wash, and should I bring anything?'],
 ['appointment','advanced',"Three of us need a consultation together. Sam is only free after two, and Lee must leave by four. Could we book Friday from two to three? Please confirm that all three of us can attend the same session.","Three of us needs a consultation together. Could we book Friday from two to three?"],
 ['smalltalk','beginner',"Hi! I'm well, thank you. How are you?",'Hi! I is well, thank you. How are you?'],
 ['smalltalk','intermediate',"I went hiking with a friend at the weekend. It was tiring but fun. How was your weekend?",'I go hiking last weekend. How was your weekend?'],
 ['smalltalk','advanced',"I've been thinking about how to make our meetings shorter. I can see why people want time to discuss things, though. Speaking of time, have you found any good ways to balance work and hobbies?","I have been thinking about shorter meetings. People needs time to discuss things, though. How do you balance work and hobbies?"],
 ['product','beginner','This is a chair. It is comfortable.','This is an chair. It is comfortable.'],
 ['product','intermediate','These desks are designed for small offices. Compared with fixed desks, they are easier to move, though they cost a little more. What kind of space are you furnishing?','These desk are designed for small offices. Would you like a demonstration?'],
 ['product','advanced','For a small team with a changing layout, our modular desks are useful because you can rearrange them. They cost more initially, but you can reuse them as the team grows. If budget is your main concern, we could start with a smaller set.','These desks can be rearranged as your team grows. They costs more initially, but a smaller set would reduce the cost.'],
 ['delivery','beginner','Next Friday, please. Can you confirm delivery for next Friday?','Can you delivers it next Friday?'],
 ['delivery','intermediate','We need twenty chairs by Friday morning. Can you confirm both the quantity and the delivery time?','We need twenty chair by Friday morning. Can you confirm the delivery time?'],
 ['delivery','advanced','Our opening is on Friday, so we need ten chairs by then. Could you split the delivery, sending ten by Friday and the remaining ten next week? We can accept that alternative if the first batch is guaranteed.','Our opening is on Friday. Could you send ten chair by Friday and the rest next week?']
];
export const curriculumCases=rows.flatMap(([lesson,level,good,bad])=>[
 {id:`${lesson}-${level}-correct`,lesson,level,kind:'correct',text:good,corrections:false,goal:true},
 {id:`${lesson}-${level}-error`,lesson,level,kind:'error',text:bad,corrections:true},
 {id:`${lesson}-${level}-help`,lesson,level,kind:'help',text:'我没听懂你刚才的话，可以先用中文解释，再教我一句简单的回答吗？',corrections:false,goal:false},
 {id:`${lesson}-${level}-unclear`,lesson,level,kind:'unclear',text:'uh ... um ...',corrections:false,goal:false}
]);
