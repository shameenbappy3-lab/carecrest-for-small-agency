
/* =========================
   CALCULATOR
========================= */

var F = [

  {
    id:"apps",
    label:"Monthly Caregiver Applicants",
    hint:"",
    min:20,
    max:150,
    step:1,
    val:100
  },

  {
    id:"mins",
    label:"Time Spent per applicant (minutes)",
    hint:"Reviewing resume, back-and-forth text messages, scheduling, conducting phone screen, documenting feedback, deciding go / no go for in-person interview",
    min:30,
    max:90,
    step:1,
    val:60
  },

  {
    id:"rate",
    label:"Office team's average hourly cost ($ per hour)",
    hint:"Owner, manager or office admin",
    min:17,
    max:30,
    step:1,
    val:25
  }

];


var box = document.getElementById("inputs");


F.forEach(function(f){

  var d = document.createElement("div");

  d.className = "field";

  d.innerHTML =

    '<label for="n_'+f.id+'">'+f.label+'</label>' +

    (f.hint ? '<small>'+f.hint+'</small>' : '') +

    '<div class="row">' +

      '<input type="range" ' +

        'id="r_'+f.id+'" ' +

        'min="'+f.min+'" ' +

        'max="'+f.max+'" ' +

        'step="'+f.step+'" ' +

        'value="'+f.val+'" ' +

        'aria-label="'+f.label+' slider">' +

      '<input type="number" ' +

        'id="n_'+f.id+'" ' +

        'min="'+f.min+'" ' +

        'max="'+f.max+'" ' +

        'value="'+f.val+'">' +

    '</div>';

  box.appendChild(d);


  var r = d.querySelector('input[type="range"]');
  var n = d.querySelector('input[type="number"]');


  r.addEventListener("input",function(){

    n.value = r.value;

    calc();

  });


  n.addEventListener("input",function(){

    var value = parseFloat(n.value);

    if(!Number.isNaN(value)){
      r.value = value;
    }

    calc();

  });


  n.addEventListener("change",function(){

    var value = parseFloat(n.value);

    if(Number.isNaN(value)){
      value = f.val;
    }

    value = Math.min(f.max, Math.max(f.min, value));

    n.value = value;
    r.value = value;

    calc();

  });

});


function v(id){

  return Math.max(
    0,
    parseFloat(
      document.getElementById("n_"+id).value
    ) || 0
  );

}


function fmt(x){

  return Math.round(x).toLocaleString("en-US");

}


function calc(){

  var hm =
    v("apps") * v("mins") / 60;

  document.getElementById("hm").textContent =
    fmt(hm);

  document.getElementById("hy").textContent =
    fmt(hm * 12);

  document.getElementById("wk").textContent =
    (hm * 12 / 52).toFixed(1);

  document.getElementById("cost").textContent =
    "$" + fmt(
      hm * 12 * v("rate")
    );

}


calc();


/* =========================
   TESTIMONIALS
========================= */

var T = [

  {
    q:"We used to lose a whole afternoon a week to voicemail tag. Now the calls just happen overnight.",
    n:"Denise M.",
    r:"Owner, home care agency — Texas"
  },

  {
    q:"Found out someone's CNA had expired years ago before we ever scheduled the interview. That alone paid for the month.",
    n:"Carla R.",
    r:"Agency Director — Georgia"
  },

  {
    q:"I was the one screening between everything else. This gave me my Tuesdays back.",
    n:"Patricia L.",
    r:"Owner — North Carolina"
  },

  {
    q:"The scorecards read like something a recruiter wrote, not a call log. Makes the handoff to interviews easy.",
    n:"Sam K.",
    r:"Office Manager — Ohio"
  },

  {
    q:"Small team, no HR department. This is the closest thing we have to one.",
    n:"Mike T.",
    r:"Care Coordinator — Florida"
  }

];


var mtrack =
  document.getElementById("mtrack");


function card(t){

  var d =
    document.createElement("div");

  d.className = "t-card";

  d.innerHTML =

    '<p>“'+t.q+'”</p>' +

    '<div class="t-who">' +

      '<b>'+t.n+'</b>' +

      '<span>'+t.r+'</span>' +

    '</div>';

  return d;

}


T.concat(T).forEach(function(t){

  mtrack.appendChild(
    card(t)
  );

});


/* =========================
   SCROLL REVEAL
========================= */

(function(){

  var reduced =
    window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

  var nodes =
    document.querySelectorAll(
      "[data-reveal]"
    );


  if(
    reduced ||
    !("IntersectionObserver" in window)
  ){

    nodes.forEach(function(el){

      el.classList.add("is-in");

    });

    return;

  }


  var io =
    new IntersectionObserver(

      function(entries){

        entries.forEach(function(e){

          if(e.isIntersecting){

            e.target.classList.add("is-in");

            io.unobserve(e.target);

          }

        });

      },

      {
        threshold:0.16,
        rootMargin:"0px 0px -8% 0px"
      }

    );


  nodes.forEach(function(el){

    io.observe(el);

  });

})();
