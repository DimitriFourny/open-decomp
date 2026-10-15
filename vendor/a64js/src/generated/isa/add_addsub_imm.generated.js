export const ENCODINGS = [
    {
        "instructionId": "ADD_addsub_imm",
        "encodingId": "ADD_32_addsub_imm",
        "mnemonic": "ADD",
        "className": "Not setting the condition flags",
        "fileName": "add_addsub_imm.xml",
        "mask": 4286578688,
        "value": 285212672,
        "bitCount": 9,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "sh",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm12",
                "lsb": 10,
                "width": 12
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "add-sub-immediate"
    },
    {
        "instructionId": "ADD_addsub_imm",
        "encodingId": "ADD_64_addsub_imm",
        "mnemonic": "ADD",
        "className": "Not setting the condition flags",
        "fileName": "add_addsub_imm.xml",
        "mask": 4286578688,
        "value": 2432696320,
        "bitCount": 9,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "sh",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm12",
                "lsb": 10,
                "width": 12
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "add-sub-immediate"
    }
];
